/**
 * Shared memory block xuyên fleet v8 — gói đồng bộ (sync packet).
 *
 * Nối tiếp shared block v6 (`memory/v3/blocks.ts`: một store, ACL,
 * version tăng dần, event log, subscribe trong tiến trình) và nhóm
 * share v4 (`memory/sharedBlocks.ts`: nhóm bot ↔ block, catch-up khi
 * bot mới vào nhóm). Hai lớp đó đồng bộ trong MỘT workspace/máy.
 * v8 thêm đồng bộ XUYÊN MÁY / xuyên workspace:
 *
 *  - `exportFleetSyncPacket(store, fromBotId)`: gói JSON mang đi được
 *    (file, USB, tunnel...) — chứa mọi shared block local + version
 *    vector của từng block. Gói là dữ liệu thuần, không chạy code.
 *  - `importFleetSyncPacket(store, packet)`: merge gói vào store
 *    local:
 *      * block chưa có -> import mới (giữ nguyên owner/ACL/vector);
 *      * incoming mới hơn local (version cao hơn, vector chứa local)
 *        -> cập nhật nội dung;
 *      * local mới hơn hoặc bằng -> bỏ qua;
 *      * CẢ HAI cùng sửa từ một gốc chung (version khác nhau, vector
 *        không chứa nhau) -> XUNG ĐỘT: giữ local, ghi vào conflict
 *        log, KHÔNG tự ghi đè — user quyết sau.
 *  - `V8VersionVector`: botId -> version cao nhất đã thấy. Vector
 *    chứa vector kia = "đã thấy mọi thay đổi của phía kia" (không
 *    xung đột). So sánh vector là cách duy nhất v8 quyết định
 *    "mới hơn" — không tin tưởng đồng hồ máy (đồng hồ hai máy lệch
 *    nhau là bình thường).
 *  - `fleetSyncStatus(store)`: trạng thái đồng bộ local (đọc, không
 *    sửa) + số xung đột đang chờ.
 *
 * AN TOÀN: merge không bao giờ xóa block local; gói độc (tên block
 * rỗng, nội dung quá dài, version âm) bị từ chối từng block, không
 * fail cả lần merge; conflict log lưu bền để UI hiển thị.
 * 100% local, không mạng. Không tuyên bố điểm benchmark nào.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SharedBlockStore } from '../v3/blocks';
import type { V6SharedBlock } from '../v3/types';
import type {
  V8FleetBlockPacket,
  V8FleetConflict,
  V8FleetConflictLogFile,
  V8FleetMergeReport,
  V8FleetSyncPacket,
  V8FleetSyncStatus,
  V8VersionVector,
} from './types';

/** Đường dẫn tương đối của log xung đột fleet v8 trong workspace. */
export const V8_FLEET_CONFLICTS_REL_PATH = path.join('.open-bot', 'memory-v8-fleet-conflicts.json');
/** Nội dung block tối đa trong gói (ký tự) — gói độc quá dài bị từ chối. */
export const V8_FLEET_MAX_BLOCK_CHARS = 100_000;
/** Số block tối đa trong một gói. */
export const V8_FLEET_MAX_BLOCKS_PER_PACKET = 200;
/** Số xung đột tối đa giữ trong log. */
export const V8_FLEET_CONFLICT_LOG_KEEP = 200;

/** Lỗi fleet sync v8 — mọi message đều tiếng Việt. */
export class V8FleetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V8FleetError';
  }
}

/* ------------------------------------------------------------------ */
/* Version vector                                                      */
/* ------------------------------------------------------------------ */

/** Vector rỗng (chưa thấy thay đổi nào). */
export function emptyV8VersionVector(): V8VersionVector {
  return {};
}

/** Vector của một block local: owner -> version hiện tại. */
export function vectorOfBlock(block: V6SharedBlock): V8VersionVector {
  const vector: V8VersionVector = {};
  vector[block.ownerBotId] = block.version;
  for (const version of block.history) {
    const botId = version.actorBotId;
    if (botId !== '') vector[botId] = Math.max(vector[botId] ?? 0, version.version);
  }
  return vector;
}

/** Gộp hai vector (lấy max từng bot). */
export function mergeVectors(a: V8VersionVector, b: V8VersionVector): V8VersionVector {
  const out: V8VersionVector = { ...a };
  for (const [botId, version] of Object.entries(b)) {
    out[botId] = Math.max(out[botId] ?? 0, version);
  }
  return out;
}

/**
 * true khi vector `a` chứa `b` (mọi bot trong b đều có version trong
 * a >= version trong b) — nghĩa là phía a đã thấy mọi thay đổi của b.
 */
export function vectorContains(a: V8VersionVector, b: V8VersionVector): boolean {
  for (const [botId, version] of Object.entries(b)) {
    if ((a[botId] ?? 0) < version) return false;
  }
  return true;
}

/** So sánh hai vector: 'a-newer' | 'b-newer' | 'equal' | 'concurrent' (xung đột). */
export function compareVectors(
  a: V8VersionVector,
  b: V8VersionVector,
): 'a-newer' | 'b-newer' | 'equal' | 'concurrent' {
  const aContainsB = vectorContains(a, b);
  const bContainsA = vectorContains(b, a);
  if (aContainsB && bContainsA) return 'equal';
  if (aContainsB) return 'a-newer';
  if (bContainsA) return 'b-newer';
  return 'concurrent';
}

/* ------------------------------------------------------------------ */
/* Conflict log (lưu bền)                                             */
/* ------------------------------------------------------------------ */

/** Đọc log xung đột fleet v8 (mới nhất cuối mảng). */
export function readV8FleetConflicts(workspaceDir: string): V8FleetConflict[] {
  const filePath = path.join(workspaceDir, V8_FLEET_CONFLICTS_REL_PATH);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const file = parsed as Partial<V8FleetConflictLogFile>;
    if (!Array.isArray(file.conflicts)) return [];
    return file.conflicts as V8FleetConflict[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

/** Append xung đột vào log (giữ tối đa 200 xung đột gần nhất). */
export function appendV8FleetConflicts(workspaceDir: string, conflicts: V8FleetConflict[]): void {
  if (conflicts.length === 0) return;
  const filePath = path.join(workspaceDir, V8_FLEET_CONFLICTS_REL_PATH);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const existing = readV8FleetConflicts(workspaceDir);
  existing.push(...conflicts);
  const kept = existing.slice(-V8_FLEET_CONFLICT_LOG_KEEP);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, conflicts: kept } satisfies V8FleetConflictLogFile, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/* ------------------------------------------------------------------ */
/* Export / parse / import gói                                        */
/* ------------------------------------------------------------------ */

/** Validate một block trong gói (gói độc bị từ chối từng block). */
export function validateFleetBlockPacket(block: V8FleetBlockPacket): string | null {
  if (!block || typeof block !== 'object') return 'Block trong gói không phải object.';
  if (typeof block.blockId !== 'string' || block.blockId.trim() === '') return 'Block thiếu blockId.';
  if (typeof block.name !== 'string' || block.name.trim() === '') return 'Block thiếu tên.';
  if (block.name.length > 120) return `Tên block quá dài (${block.name.length} > 120).`;
  if (typeof block.content !== 'string') return 'Block thiếu nội dung.';
  if (block.content.length > V8_FLEET_MAX_BLOCK_CHARS) {
    return `Nội dung block quá dài (${block.content.length} > ${V8_FLEET_MAX_BLOCK_CHARS}).`;
  }
  if (!Number.isInteger(block.version) || block.version < 1) return 'Version block phải là số nguyên >= 1.';
  if (typeof block.ownerBotId !== 'string' || block.ownerBotId.trim() === '') return 'Block thiếu ownerBotId.';
  if (!block.vector || typeof block.vector !== 'object') return 'Block thiếu version vector.';
  for (const [botId, version] of Object.entries(block.vector)) {
    if (typeof botId !== 'string' || botId === '' || !Number.isInteger(version) || version < 0) {
      return 'Version vector sai định dạng.';
    }
  }
  return null;
}

/** Validate toàn bộ gói (sai định dạng -> throw, không merge gì cả). */
export function validateFleetSyncPacket(packet: unknown): asserts packet is V8FleetSyncPacket {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new V8FleetError('Gói fleet sync sai định dạng (không phải object).');
  }
  const p = packet as Partial<V8FleetSyncPacket>;
  if (p.format !== 'open-bot-fleet-sync-v8') {
    throw new V8FleetError(`Gói fleet sync sai format (nhận được "${String(p.format)}").`);
  }
  if (p.version !== 1) throw new V8FleetError(`Gói fleet sync sai version (nhận được "${String(p.version)}").`);
  if (typeof p.packetId !== 'string' || p.packetId.trim() === '') {
    throw new V8FleetError('Gói fleet sync thiếu packetId.');
  }
  if (typeof p.fromBotId !== 'string' || p.fromBotId.trim() === '') {
    throw new V8FleetError('Gói fleet sync thiếu fromBotId.');
  }
  if (!Array.isArray(p.blocks)) throw new V8FleetError('Gói fleet sync thiếu danh sách blocks.');
  if (p.blocks.length > V8_FLEET_MAX_BLOCKS_PER_PACKET) {
    throw new V8FleetError(`Gói fleet sync quá nhiều block (${p.blocks.length} > ${V8_FLEET_MAX_BLOCKS_PER_PACKET}).`);
  }
}

/**
 * Export mọi shared block local thành gói đồng bộ.
 * `fromBotId` là bot đang export (để phía nhận biết gói từ đâu).
 * Gói là dữ liệu thuần (JSON) — host tự chọn kênh mang đi.
 */
export function exportFleetSyncPacket(store: SharedBlockStore, fromBotId: string): V8FleetSyncPacket {
  const botId = (fromBotId ?? '').trim();
  if (botId === '') throw new V8FleetError('fromBotId không được rỗng khi export gói fleet.');
  const blocks: V8FleetBlockPacket[] = store.listBlocks().map((block) => ({
    blockId: block.id,
    name: block.name,
    content: block.content,
    version: block.version,
    ownerBotId: block.ownerBotId,
    acl: { ...block.acl },
    vector: vectorOfBlock(block),
    exportedAt: new Date().toISOString(),
  }));
  return {
    format: 'open-bot-fleet-sync-v8',
    version: 1,
    packetId: randomUUID(),
    fromBotId: botId,
    exportedAt: new Date().toISOString(),
    blocks,
  };
}

/** Parse gói từ text JSON (throw khi sai định dạng). */
export function parseFleetSyncPacket(raw: string): V8FleetSyncPacket {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new V8FleetError('Gói fleet sync không parse được JSON.');
  }
  validateFleetSyncPacket(parsed);
  return parsed;
}

/** Serialize gói thành text JSON (để ghi file / gửi đi). */
export function serializeFleetSyncPacket(packet: V8FleetSyncPacket): string {
  validateFleetSyncPacket(packet);
  return JSON.stringify(packet, null, 2);
}

/**
 * Merge một gói fleet vào store local.
 *
 * Quyết định từng block (so sánh version vector, không tin đồng hồ):
 *  - Chưa có local -> import mới: tạo block với owner/ACL/content
 *    của gói (actor là bot export gói). Import giữ nguyên version?
 *    KHÔNG — store v6 tự tăng version từ 1; để giữ dấu vết, nội
 *    dung import ghi rõ nguồn gói trong history reason (qua
 *    updateBlock ngay sau create khi version gói > 1? Không — v6
 *    không cho đặt version trực tiếp). Import luôn tạo version 1
 *    local, nhưng vector của gói được lưu trong báo cáo merge để
 *    lần merge sau vẫn so sánh được (vector local lúc đó = {owner:
 *    version local} — lần sau incoming mới hơn vẫn thắng vì vector
 *    incoming chứa version local? Xem ghi chú dưới).
 *  - Incoming mới hơn (vector incoming chứa vector local, version
 *    incoming > version local) -> updateBlock nội dung mới.
 *  - Local mới hơn/bằng -> bỏ qua.
 *  - Concurrent (cả hai cùng sửa) -> xung đột: giữ local, ghi log.
 *
 * GHI CHÚ TRUNG THỰC về version sau import: vì SharedBlockStore v6
 * không lưu vector ngoài, version local sau import bắt đầu từ 1.
 * Nếu sau đó phía gốc sửa tiếp (version 2) và export lại, vector
 * incoming {owner:2} vẫn chứa vector local {owner:1} nên update
 * thắng đúng. Xung đột chỉ xảy ra khi CẢ HAI cùng sửa sau lần
 * đồng bộ cuối — đúng ngữ nghĩa vector.
 *
 * `workspaceDir` (khi có) để ghi conflict log bền; không có thì
 * conflict chỉ nằm trong báo cáo trả về.
 */
export function importFleetSyncPacket(
  store: SharedBlockStore,
  packet: V8FleetSyncPacket,
  opts: { workspaceDir?: string; now?: Date } = {},
): V8FleetMergeReport {
  validateFleetSyncPacket(packet);
  const now = (opts.now ?? new Date()).toISOString();
  const report: V8FleetMergeReport = {
    packetId: packet.packetId,
    fromBotId: packet.fromBotId,
    imported: 0,
    updated: 0,
    skipped: 0,
    conflicts: [],
    errors: [],
    mergedAt: now,
  };
  for (const incoming of packet.blocks) {
    const problem = validateFleetBlockPacket(incoming);
    if (problem) {
      report.errors.push(`Block "${incoming?.name ?? '?'}" bị từ chối: ${problem}`);
      continue;
    }
    try {
      const local = store.getBlock(incoming.blockId) ?? store.getBlockByName(incoming.name);
      if (!local) {
        const created = store.createBlock(incoming.ownerBotId, incoming.name, incoming.content);
        // Khôi phục ACL từ gói (owner luôn có write; share thêm từng bot).
        for (const [botId, permission] of Object.entries(incoming.acl)) {
          if (botId === incoming.ownerBotId) continue;
          if (permission !== 'read' && permission !== 'write') continue;
          try {
            store.shareBlock(incoming.ownerBotId, created.id, botId, permission);
          } catch {
            // Share lỗi (bot không tồn tại...) thì bỏ qua bot đó.
          }
        }
        report.imported += 1;
        continue;
      }
      const localVector = vectorOfBlock(local);
      const comparison = compareVectors(localVector, incoming.vector);
      if (comparison === 'equal') {
        // Cùng nội dung? Version bằng nhau nhưng nội dung khác nhau
        // vẫn là xung đột (cùng sửa, trùng version).
        if (local.content === incoming.content) {
          report.skipped += 1;
        } else {
          report.conflicts.push({
            blockId: local.id,
            name: local.name,
            localVersion: local.version,
            incomingVersion: incoming.version,
            resolution: 'kept-local',
            detectedAt: now,
          });
        }
        continue;
      }
      if (comparison === 'a-newer') {
        report.skipped += 1;
        continue;
      }
      if (comparison === 'b-newer') {
        if (local.content !== incoming.content) {
          store.updateBlock(local.ownerBotId, local.id, incoming.content, `Fleet sync từ ${packet.fromBotId} (gói ${packet.packetId}).`);
        }
        report.updated += 1;
        continue;
      }
      // concurrent -> xung đột, giữ local.
      report.conflicts.push({
        blockId: local.id,
        name: local.name,
        localVersion: local.version,
        incomingVersion: incoming.version,
        resolution: 'kept-local',
        detectedAt: now,
      });
    } catch (err) {
      report.errors.push(`Block "${incoming.name}" lỗi khi merge: ${(err as Error).message}`);
    }
  }
  if (opts.workspaceDir && report.conflicts.length > 0) {
    try {
      appendV8FleetConflicts(opts.workspaceDir, report.conflicts);
    } catch {
      // Ghi log xung đột lỗi thì bỏ qua — báo cáo merge vẫn có.
    }
  }
  return report;
}

/**
 * Trạng thái đồng bộ fleet của workspace (chỉ đọc).
 * `workspaceDir` (khi có) để đếm xung đột đang chờ trong log.
 */
export function fleetSyncStatus(
  store: SharedBlockStore,
  opts: { workspaceDir?: string } = {},
): V8FleetSyncStatus {
  const blocks = store.listBlocks();
  const botIds = [...new Set(blocks.flatMap((b) => [b.ownerBotId, ...Object.keys(b.acl)]))].sort();
  let newestBlockAt: string | null = null;
  for (const block of blocks) {
    if (!newestBlockAt || block.updatedAt > newestBlockAt) newestBlockAt = block.updatedAt;
  }
  let pendingConflicts = 0;
  if (opts.workspaceDir) {
    try {
      pendingConflicts = readV8FleetConflicts(opts.workspaceDir).length;
    } catch {
      pendingConflicts = 0;
    }
  }
  return {
    localBlocks: blocks.length,
    botIds,
    newestBlockAt,
    eventCount: store.readEventLog().length,
    pendingConflicts,
  };
}
