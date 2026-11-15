/**
 * Provenance v8 — nguồn gốc + chuỗi bằng chứng của mỗi fact.
 *
 * Nối tiếp `memory/provenance.ts` (v0.97, Memory v2): hàm đó quét nội
 * dung nghi ngờ, tính trust theo loại nguồn và ghi audit log. v8 thêm
 * hai lớp còn thiếu:
 *  1. `V8FactProvenance` — một bản provenance đầy đủ gắn với một bản
 *     ghi v6 (hoặc block v7): nguồn gốc + chuỗi bằng chứng (evidence
 *     chain) + trust lúc ghi. Chuỗi bằng chứng cho user thấy fact tới
 *     từ đâu (chat nào, tool nào, file nào, gói sync nào).
 *  2. `SourceTrustRegistry` — registry độ tin cậy theo NGUỒN (không
 *     phải theo loại nguồn chung chung): user hạ trust của một tool
 *     hay một file import cụ thể, mọi fact sau đó từ nguồn đó bị hạ
 *     trust theo. Registry lưu bền trong workspace, chỉnh được.
 *
 * 100% local, xác định (deterministic), không gọi model/mạng.
 * Không tuyên bố điểm benchmark nào (xem types.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { V6RecordView } from '../v3/types';
import {
  createProvenance,
  detectSuspiciousContent,
  SOURCE_TRUST,
  trustScore,
} from '../provenance';
import type { ProvenanceSourceKind } from '../provenance';
import type {
  V8EvidenceLink,
  V8FactProvenance,
  V8SourceKind,
  V8SourceTrustEntry,
  V8SourceTrustFile,
} from './types';

/** Đường dẫn tương đối của registry trust nguồn v8 trong workspace. */
export const V8_SOURCE_TRUST_REL_PATH = path.join('.open-bot', 'memory-v8-source-trust.json');

/** Lỗi provenance v8 — mọi message đều tiếng Việt. */
export class V8ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V8ProvenanceError';
  }
}

/** Độ tin cậy cơ sở mặc định theo loại nguồn v8 (kế thừa bảng v2). */
export const V8_SOURCE_KIND_TRUST: Record<V8SourceKind, number> = {
  user: SOURCE_TRUST.user,
  system: SOURCE_TRUST.system,
  bot: SOURCE_TRUST.bot,
  tool: SOURCE_TRUST.tool,
  import: SOURCE_TRUST.import,
  sleep: 0.85,
  fleet: 0.55,
};

/** Chuyển loại nguồn v6 (chuỗi tự do) về loại nguồn v8. */
export function v8SourceKindOf(v6Type: string): V8SourceKind {
  switch ((v6Type ?? '').trim().toLowerCase()) {
    case 'user':
      return 'user';
    case 'tool':
      return 'tool';
    case 'sleep':
      return 'sleep';
    case 'migration':
    case 'import':
      return 'import';
    case 'longterm':
    case 'graph':
    case 'system':
      return 'system';
    default:
      return 'bot';
  }
}

/** Khóa nguồn chuẩn cho một bản ghi v6: "loại:ref". */
export function v8SourceKeyOf(record: Pick<V6RecordView, 'source'>): string {
  const kind = v8SourceKindOf(record.source.type);
  const ref = (record.source.ref ?? '').trim();
  return ref === '' ? kind : `${kind}:${ref}`;
}

/** Khóa nguồn chuẩn từ loại + ref rời (dùng khi chưa có bản ghi). */
export function v8SourceKey(kind: V8SourceKind, ref: string): string {
  const trimmed = (ref ?? '').trim();
  return trimmed === '' ? kind : `${kind}:${trimmed}`;
}

/**
 * Xây provenance v8 cho một bản ghi v6.
 *
 *  - Nguồn gốc lấy từ `record.source` (loại + ref + bot).
 *  - Trust lúc ghi = trust v2 (loại nguồn + flag + tuổi) rồi nhân
 *    với trust riêng của nguồn trong registry (nếu registry có entry
 *    cho nguồn đó) — nguồn bị user hạ trust thì fact mới cũng bị hạ.
 *  - Chuỗi bằng chứng bắt đầu bằng một mắt xích từ sourceText (khi
 *    có) + các mắt xích caller truyền thêm.
 *  - Flag nghi ngờ được quét lại từ text (không tin flag cũ).
 */
export function buildV8Provenance(
  record: V6RecordView,
  opts: {
    registry?: SourceTrustRegistry | null;
    extraEvidence?: V8EvidenceLink[];
    now?: Date;
  } = {},
): V8FactProvenance {
  const kind = v8SourceKindOf(record.source.type);
  const origin = (record.source.ref ?? '').trim() || record.source.type;
  const flags = detectSuspiciousContent(record.text).map((f) => f.code);
  const base = createProvenance({
    source: kind as ProvenanceSourceKind,
    botId: record.source.botId ?? record.scope.agentId ?? '',
    userId: record.scope.userId || undefined,
    origin,
    text: record.text,
    recordedAt: record.createdAt,
  });
  let trust = trustScore(
    { source: kind as ProvenanceSourceKind, flags: base.flags, quarantined: false, recordedAt: record.createdAt },
    opts.now ?? new Date(),
  );
  const sourceKey = v8SourceKeyOf(record);
  if (opts.registry) {
    const entry = opts.registry.get(sourceKey);
    if (entry) trust = Math.round(trust * entry.baseTrust * 100) / 100;
  }
  const evidence: V8EvidenceLink[] = [];
  const sourceText = (record.source.sourceText ?? '').trim();
  if (sourceText !== '') {
    evidence.push({
      kind: 'chat',
      ref: origin,
      note: sourceText.slice(0, 200),
      at: record.createdAt,
    });
  }
  for (const link of opts.extraEvidence ?? []) {
    evidence.push({
      kind: link.kind,
      ref: link.ref,
      ...(link.note !== undefined ? { note: link.note.slice(0, 200) } : {}),
      at: link.at,
    });
  }
  return {
    recordId: record.id,
    sourceKind: kind,
    origin,
    botId: record.source.botId ?? record.scope.agentId ?? '',
    userId: record.scope.userId ?? '',
    recordedAt: record.createdAt,
    trust: Math.max(0, Math.min(1, trust)),
    evidence,
    flags,
    quarantined: record.status === 'quarantined',
  };
}

/** Định dạng provenance thành text đọc được (cho UI/log/agent). */
export function formatV8Provenance(prov: V8FactProvenance): string {
  const lines: string[] = [];
  lines.push(`Fact ${prov.recordId} — nguồn ${prov.sourceKind}:${prov.origin}`);
  lines.push(`  bot: ${prov.botId === '' ? '(chung)' : prov.botId} · user: ${prov.userId === '' ? '(không rõ)' : prov.userId}`);
  lines.push(`  ghi lúc: ${prov.recordedAt} · trust: ${prov.trust.toFixed(2)}${prov.quarantined ? ' · ĐANG QUARANTINE' : ''}`);
  if (prov.flags.length > 0) lines.push(`  flag nghi ngờ: ${prov.flags.join(', ')}`);
  if (prov.evidence.length === 0) {
    lines.push('  bằng chứng: (không có — fact mồ côi, nên xác minh lại)');
  } else {
    lines.push('  bằng chứng:');
    for (const link of prov.evidence) {
      lines.push(`    - [${link.kind}] ${link.ref}${link.note ? ` — ${link.note}` : ''} (${link.at})`);
    }
  }
  return lines.join('\n');
}

/** File registry rỗng (để khởi tạo). */
export function emptyV8SourceTrustFile(): V8SourceTrustFile {
  return { version: 1, entries: [] };
}

/**
 * Registry độ tin cậy theo nguồn (lưu bền, user điều chỉnh được).
 *
 *  - `get(sourceKey)`: entry của nguồn (undefined khi chưa có).
 *  - `setBaseTrust(sourceKey, trust, note?)`: user đặt trust cho một
 *    nguồn (0..1). Ghi bền ngay.
 *  - `noteFact(sourceKey, flagged)`: đếm fact mới từ nguồn (để UI
 *    thấy nguồn nào hay bị flag). Ghi bền ngay khi có thay đổi.
 *  - `effectiveTrust(kind, sourceKey)`: trust hiệu dụng = trust loại
 *    nguồn * trust riêng của nguồn (mặc định 1 khi chưa đặt).
 *  - `list()`: toàn bộ entry, sắp theo flaggedCount giảm dần (nguồn
 *    đáng ngờ nhất lên đầu) để user rà soát.
 *  - In-memory khi không có dir (dùng cho test).
 */
export class SourceTrustRegistry {
  private readonly filePath: string | null;
  private entries: V8SourceTrustEntry[] = [];
  private loaded = false;

  constructor(opts: { dir?: string; filePath?: string; inMemory?: boolean } = {}) {
    if (opts.inMemory) {
      this.filePath = null;
    } else if (opts.filePath) {
      this.filePath = opts.filePath;
    } else if (opts.dir) {
      this.filePath = path.join(opts.dir, V8_SOURCE_TRUST_REL_PATH);
    } else {
      this.filePath = null;
    }
  }

  /** Registry file-backed trong workspace của bot. */
  static fromWorkspace(workspaceDir: string): SourceTrustRegistry {
    return new SourceTrustRegistry({ dir: workspaceDir });
  }

  /** Registry thuần bộ nhớ (test). */
  static inMemory(): SourceTrustRegistry {
    return new SourceTrustRegistry({ inMemory: true });
  }

  /** Đường dẫn file (null khi in-memory). */
  get path(): string | null {
    return this.filePath;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V8ProvenanceError(`File registry trust nguồn v8 hỏng (không parse được JSON): ${this.filePath}`);
    }
    const file = parsed as Partial<V8SourceTrustFile>;
    if (!Array.isArray(file.entries)) {
      throw new V8ProvenanceError(`File registry trust nguồn v8 sai định dạng: ${this.filePath}`);
    }
    this.entries = (file.entries as V8SourceTrustEntry[]).filter(
      (e) => e && typeof e.sourceKey === 'string' && e.sourceKey !== '',
    );
  }

  /** Ghi toàn bộ registry ra đĩa (atomic: temp + rename, mode 0600). */
  save(): void {
    if (!this.filePath) return;
    this.load();
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload: V8SourceTrustFile = { version: 1, entries: this.entries };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Entry của một nguồn (undefined khi chưa có). */
  get(sourceKey: string): V8SourceTrustEntry | undefined {
    this.load();
    const found = this.entries.find((e) => e.sourceKey === sourceKey);
    return found ? { ...found } : undefined;
  }

  /**
   * User đặt độ tin cậy cho một nguồn (0..1). Tạo entry mới khi chưa
   * có (factCount giữ 0). Ghi bền ngay.
   */
  setBaseTrust(sourceKey: string, trust: number, note?: string): V8SourceTrustEntry {
    const key = (sourceKey ?? '').trim();
    if (key === '') throw new V8ProvenanceError('sourceKey không được rỗng.');
    if (!Number.isFinite(trust) || trust < 0 || trust > 1) {
      throw new V8ProvenanceError(`baseTrust phải trong 0..1, nhận được ${trust}.`);
    }
    this.load();
    const now = new Date().toISOString();
    const existing = this.entries.find((e) => e.sourceKey === key);
    if (existing) {
      existing.baseTrust = Math.round(trust * 100) / 100;
      if (note !== undefined) existing.note = note.slice(0, 200);
      existing.updatedAt = now;
      this.save();
      return { ...existing };
    }
    const entry: V8SourceTrustEntry = {
      sourceKey: key,
      baseTrust: Math.round(trust * 100) / 100,
      factCount: 0,
      flaggedCount: 0,
      ...(note !== undefined ? { note: note.slice(0, 200) } : {}),
      updatedAt: now,
    };
    this.entries.push(entry);
    this.save();
    return { ...entry };
  }

  /**
   * Ghi nhận một fact mới từ nguồn (đếm fact + flag). Không throw khi
   * ghi đĩa lỗi — đếm trong bộ nhớ vẫn đúng cho lần chạy này.
   */
  noteFact(sourceKey: string, flagged: boolean): void {
    const key = (sourceKey ?? '').trim();
    if (key === '') return;
    this.load();
    const now = new Date().toISOString();
    const existing = this.entries.find((e) => e.sourceKey === key);
    if (existing) {
      existing.factCount += 1;
      if (flagged) existing.flaggedCount += 1;
      existing.updatedAt = now;
    } else {
      this.entries.push({
        sourceKey: key,
        baseTrust: 1,
        factCount: 1,
        flaggedCount: flagged ? 1 : 0,
        updatedAt: now,
      });
    }
    try {
      this.save();
    } catch {
      // Ghi đĩa lỗi thì bỏ qua — đếm trong bộ nhớ vẫn giữ.
    }
  }

  /**
   * Trust hiệu dụng của một nguồn: trust loại nguồn * trust riêng
   * của nguồn (mặc định 1 khi user chưa đặt). Kết quả 0..1.
   */
  effectiveTrust(kind: V8SourceKind, sourceKey: string): number {
    const entry = this.get(sourceKey);
    const base = V8_SOURCE_KIND_TRUST[kind] ?? 0.5;
    const factor = entry ? entry.baseTrust : 1;
    return Math.max(0, Math.min(1, Math.round(base * factor * 100) / 100));
  }

  /** Toàn bộ entry, nguồn đáng ngờ nhất (flagged nhiều nhất) lên đầu. */
  list(): V8SourceTrustEntry[] {
    this.load();
    return this.entries
      .map((e) => ({ ...e }))
      .sort((a, b) => b.flaggedCount - a.flaggedCount || b.factCount - a.factCount);
  }

  /** Số nguồn đã có entry trong registry. */
  count(): number {
    this.load();
    return this.entries.length;
  }
}
