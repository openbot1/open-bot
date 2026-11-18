/**
 * Memory v21 — Portable memory (v1.29, Doi T1).
 *
 * Y tuong hoc tu Open Memory Spec / OKF (Google Cloud OKF v0.2,
 * 09/11/2026), MacPaw Portable Memory (.mem bundle, deletion
 * tombstones), Letta git-backed memory (MemFS), OpenHands 2-tier
 * MEMORY.md + daily logs, va W3C AI Agent Memory Interoperability
 * CG — tu thiet ke lai hoan toan cho open-bot, KHONG copy
 * code/text/tai san cua bat ky repo nao.
 *
 * Thiet ke:
 *  - `V21PortableRecord`: ban ghi chuan hoa duy nhat trong nha.
 *    Moi format ngoai (OKF / MemFS / OpenHands) deu convert hai
 *    chieu ve record nay, co bao cao mat mat (loss report) chu
 *    khong bao gio am tham bo field.
 *  - OKF-style: Markdown + YAML frontmatter, field `type` BAT
 *    BUOC; tuy chon `sources`, `verified`, `stale_after`,
 *    `code_refs`. Bundle nam trong git, review cung code.
 *  - MemFS-style: block luu thanh file trong thu muc, co manifest
 *    + hash de kiem tra toan ven, tombstone khi xoa.
 *  - OpenHands-style: 2 tang — MEMORY.md curated (da gon) +
 *    daily log memory/YYYY-MM-DD.md (tho); promote daily len
 *    curated co dedupe.
 *  - Sync + versioning: moi record co version + hash + lich su
 *    append-only; sync 3 chieu (base/local/remote) phat hien
 *    conflict (edit/edit, delete/edit, tombstone/edit).
 *  - Tombstone: xoa chi ghi tombstone, giu audit trail; chi purge
 *    cung sau thoi gian luu giu, co ghi log.
 *  - Sleep-time consolidation mo rong: cung co memory XUYEN
 *    session (noi tiep V20SleepConsolidator), boost fact xuat hien
 *    o nhieu session, danh dau stale theo `stale_after`, export
 *    bundle portable.
 *
 * Khong goi model, khong goi mang. Moi loi tra ve ket qua co cau
 * truc thay vi throw (tru truong hop lap trinh sai dau vao kieu).
 */

/** Dinh dang portable ma open-bot doc/ghi duoc. */
export type V21PortableFormat = 'okf' | 'memfs' | 'openhands';

/** Cac format duoc ho tro (de UI/test dung chung mot nguon). */
export const V21_PORTABLE_FORMATS: readonly V21PortableFormat[] = ['okf', 'memfs', 'openhands'];

/** Loai ban ghi — field `type` bat buoc trong OKF frontmatter. */
export type V21RecordType =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'person'
  | 'project'
  | 'procedure'
  | 'note'
  | 'custom';

export const V21_RECORD_TYPES: readonly V21RecordType[] = [
  'fact',
  'preference',
  'decision',
  'person',
  'project',
  'procedure',
  'note',
  'custom',
];

/** Nguoi kiem chung mot ban ghi (OKF `verified`). */
export interface V21VerifiedInfo {
  by: string;
  /** Epoch ms khi kiem chung. */
  at: number;
  /** Ghi chu kiem chung (tuy chon). */
  note?: string;
}

/** Ban ghi portable chuan hoa — dang noi bo duy nhat cua v21. */
export interface V21PortableRecord {
  /** Id slug duy nhat trong store/bundle (vd `user-thich-ca-phe`). */
  id: string;
  /** Loai ban ghi — bat buoc. */
  type: V21RecordType;
  /** Tieu de ngan (hien thi, lam ten file OKF/MemFS). */
  title: string;
  /** Noi dung chinh (Markdown). */
  body: string;
  tags: string[];
  /** Nguon goc (URL, ten file, `chat:session-...`, ...). */
  sources: string[];
  /** Ai kiem chung, khi nao. */
  verified?: V21VerifiedInfo;
  /** ISO date (YYYY-MM-DD) — sau ngay nay record coi la stale. */
  staleAfter?: string;
  /** Duong dan source code lien quan (vd `packages/core/src/x.ts`). */
  codeRefs: string[];
  /** Version tang dan, bat dau tu 1. */
  version: number;
  /** Epoch ms tao / sua lan cuoi. */
  createdAt: number;
  updatedAt: number;
  /** Format goc khi import (de biet mat mat nao khi convert). */
  originFormat?: V21PortableFormat;
  /** Duong dan goc trong bundle (neu co). */
  originPath?: string;
}

/** Frontmatter OKF-style (YAML subset) — `type` bat buoc. */
export interface V21OkfFrontmatter {
  type: V21RecordType;
  title?: string;
  tags?: string[];
  sources?: string[];
  verified?: V21VerifiedInfo;
  stale_after?: string;
  code_refs?: string[];
  /** Field khac giu nguyen khi round-trip (khong hieu thi bao). */
  [extra: string]: unknown;
}

/** Block MemFS-style: mot file trong thu muc git-backed. */
export interface V21MemfsBlock {
  id: string;
  /** Duong dan tuong doi trong store (vd `blocks/user-thich-ca-phe.md`). */
  path: string;
  title: string;
  body: string;
  /** SHA-256 hex cua body (kiem tra toan ven). */
  hash: string;
  version: number;
  updatedAt: number;
}

/** Tang OpenHands: curated (MEMORY.md) hay daily log. */
export type V21OpenHandsTier = 'curated' | 'daily';

/** Mot muc trong OpenHands MEMORY.md / daily log. */
export interface V21OpenHandsEntry {
  tier: V21OpenHandsTier;
  /** Tieu de muc (heading `##` o curated, `###` o daily). */
  heading: string;
  body: string;
  /** Ngay cua daily log (YYYY-MM-DD); undefined o curated. */
  date?: string;
  /** Gio trong daily log (HH:MM); undefined o curated. */
  time?: string;
}

/** Tombstone xoa — ghi lai thay vi xoa sach dau vet. */
export interface V21Tombstone {
  recordId: string;
  /** Format goc cua record bi xoa. */
  format: V21PortableFormat;
  /** Duong dan goc trong bundle (neu co). */
  originalPath?: string;
  /** Version cuoi cung truoc khi xoa. */
  previousVersion: number;
  /** Hash noi dung cuoi (de kiem chung khi restore). */
  previousHash: string;
  /** Snapshot noi dung cuoi — cho phep restore; purge se xoa. */
  snapshot?: V21PortableRecord;
  deletedAt: number;
  deletedBy: string;
  reason: string;
}

/** Mot muc trong lich su append-only cua mot record. */
export type V21ChangeKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'import'
  | 'convert'
  | 'sync'
  | 'promote'
  | 'stale_mark';

export interface V21RecordVersion {
  recordId: string;
  version: number;
  /** SHA-256 hex cua noi dung o version nay. */
  hash: string;
  at: number;
  by: string;
  change: V21ChangeKind;
  summary: string;
  /** Version cha (0 = tao moi). */
  parentVersion: number;
}

/** Loai conflict khi sync. */
export type V21ConflictKind =
  | 'edit_edit'
  | 'delete_edit'
  | 'edit_delete'
  | 'tombstone_edit'
  | 'version_fork';

export interface V21SyncConflict {
  recordId: string;
  kind: V21ConflictKind;
  /** Version o base (0 = chua tung ton tai). */
  baseVersion: number;
  localVersion: number;
  remoteVersion: number;
  detail: string;
}

export type V21SyncResolution = 'keep_local' | 'keep_remote' | 'keep_both' | 'manual';

export interface V21SyncReport {
  appliedLocal: string[];
  appliedRemote: string[];
  created: string[];
  deletedByTombstone: string[];
  conflicts: V21SyncConflict[];
  skipped: string[];
}

/** Mot van de validation — co code + duong dan de bao loi ro. */
export interface V21ValidationIssue {
  /** Duong dan logic (vd `records[2].frontmatter.type`, `bundle/a.md`). */
  path: string;
  code: V21ValidationCode;
  message: string;
  severity: 'error' | 'warning';
}

export type V21ValidationCode =
  | 'missing_type'
  | 'unknown_type'
  | 'bad_id'
  | 'empty_body'
  | 'empty_title'
  | 'bad_source'
  | 'bad_verified'
  | 'bad_stale_after'
  | 'bad_code_ref'
  | 'bad_version'
  | 'unknown_field'
  | 'yaml_error'
  | 'duplicate_id'
  | 'hash_mismatch'
  | 'missing_file'
  | 'stale_record';

export interface V21ValidationResult {
  ok: boolean;
  issues: V21ValidationIssue[];
  /** So loi severity=error. */
  errorCount: number;
  /** So canh bao severity=warning. */
  warningCount: number;
}

/** Bao cao convert — khong bao gio mat field am tham. */
export interface V21ConversionReport {
  from: V21PortableFormat;
  to: V21PortableFormat;
  recordsConverted: number;
  recordsSkipped: number;
  /** Field bi bo o moi record (vd `code_refs` khi sang openhands). */
  fieldsDropped: string[];
  warnings: string[];
}

/** Ket qua tra ve chung (khong throw). */
export interface V21Result<T> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

export const V21_MAX_BODY_CHARS = 20000;
export const V21_MAX_TITLE_CHARS = 200;
export const V21_MAX_SOURCES = 20;
export const V21_MAX_CODE_REFS = 20;
export const V21_MAX_TAGS = 20;
export const V21_MAX_RECORDS_PER_BUNDLE = 5000;
/** Tombstone giu toi thieu 90 ngay truoc khi duoc purge. */
export const V21_TOMBSTONE_MIN_RETENTION_DAYS = 90;
/** Nguong Jaccard de coi hai record la trung lap khi promote. */
export const V21_PROMOTE_DEDUPE_THRESHOLD = 0.6;
