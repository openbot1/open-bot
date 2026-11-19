/**
 * Memory v26 — types (v1.41, Doi T1).
 *
 * Y tuong hoc tu survey v141 muc 2 (Letta shared memory blocks, chi
 * y tuong, KHONG copy code/text/tai san cua bat ky repo nao):
 *  - Shared memory block: mot block gan cho nhieu bot/agent; mot
 *    agent cap nhat thi cac agent khac thay ngay (doc chung 1
 *    store, khong copy rieng moi bot).
 *  - Block chuan `human` (biet ve user) / `persona` (biet ve chinh
 *    agent) + custom block cho task/project.
 *  - Ba tang: core memory (block trong context, co budget token,
 *    agent phai curate thay vi tich tru) + archival memory (search
 *    theo ngay/noi dung) + recall memory (log hoi thoai, query
 *    theo ngay).
 *
 * Khac biet voi v25 (v25 da co: shared block co read-only +
 * versioning + expectedVersion, sleep agent, fact bi-temporal,
 * judge): v26 them lop quan tri tren block v25 —
 *  - Registry: 1 muc dang ky cho moi block (label, owner, bot
 *    dang attach, kind, template goc, budget, quota) — list/
 *    tim block theo owner/bot/kind thay vi quet store tho.
 *  - Audit log append-only: moi lan sua ghi ai sua, khi nao,
 *    version cu/moi, noi dung cu/moi (cat ngan) — khong the sua
 *    lai lich su.
 *  - Xung dot: 2 agent sua cung block dua tren cung version co
 *    (expectedVersion lech) thi ghi V26Conflict day du base/
 *    current/incoming + cach giai quyet (ghi de / giu hien tai /
 *    merge theo dong).
 *  - Budget/curation: gioi han token moi block; khi day, ham
 *    summarise trich xuat (extractive, chay local, khong goi
 *    model) giu y chinh, bo phan thua — co bao cao curate.
 *  - Archival + recall: version cu cua block + turn/fact duoc
 *    dua vao kho luu tru, search theo ngay + noi dung, recall
 *    query theo ngay (xem ngay hom do co gi).
 *  - Template: block chuan human/persona + mau task/project,
 *    khoi tao block dung cau truc, kiem tra field bat buoc.
 *  - Quota moi bot: gioi han so block / token / ky tu 1 bot duoc
 *    so huu hoac attach, chong 1 bot chiem het memory.
 *
 * Chay 100% local: khong goi model chat, khong goi API ngoai —
 * token estimate la uoc luong xap xi (ky tu / 4), summarise la
 * trich xuat theo diem tu khoa + vi tri, khong phai tom tat
 * bang LLM.
 */
import type {
  V25Scope,
  V25SharedBlock,
} from '../v25/types';
import {
  isoAtV25,
  makeV25Id,
} from '../v25/types';

export type { V25Scope, V25SharedBlock };

/** Loi memory v26 — message tieng Viet. */
export class V26Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V26Error';
  }
}

/** Ket qua tra ve kieu Result — loi la chuoi, khong throw qua tool. */
export type V26Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function okV26<T>(value: T): V26Result<T> {
  return { ok: true, value };
}

export function errV26<T>(error: string): V26Result<T> {
  return { ok: false, error };
}

/** Tao id duy nhat co prefix (vd "reg_...", "aud_...", "cf_..."). */
export function makeV26Id(prefix: string): string {
  return makeV25Id(prefix);
}

/** ISO string tai thoi diem ms cho truoc (mac dinh now). */
export function isoAtV26(ms: number): string {
  return isoAtV25(ms);
}

/**
 * Uoc luong token cua text (xap xi, local): 1 token ~ 4 ky tu
 * cho text tieng Anh, tieng Viet co dau dac hon nen he so nay la
 * gioi han duoi — dung de so sanh voi budget, KHONG phai dem
 * token chinh xac cua model. Ghi ro la estimate o moi noi hien.
 */
export function estimateTokensV26(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Cat ngan text ve gioi han, them dau ... neu bi cat. */
export function truncateV26(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  return `${text.slice(0, limit - 3)}...`;
}

/** Parse ISO date, tra null neu khong hop le. */
export function parseIsoV26(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Day key `YYYY-MM-DD` (UTC) cua 1 thoi diem ISO — dung lam khoa
 * partition cho archival + recall theo ngay.
 */
export function dayKeyV26(iso: string): string | null {
  const d = parseIsoV26(iso);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/** Day key cua ngay hom nay (UTC). */
export function todayKeyV26(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Kiem tra day key hop le `YYYY-MM-DD` va la ngay that. */
export function isValidDayKeyV26(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

/** Cong/tru N ngay vao 1 day key, tra day key moi (null neu sai). */
export function shiftDayKeyV26(dayKey: string, deltaDays: number): string | null {
  if (!isValidDayKeyV26(dayKey)) return null;
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Chuan hoa text de so sanh/tim kiem (lowercase, gom khoang trang). */
export function normalizeTextV26(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tach text thanh token chu (bo dau cau) de tinh overlap/diem. */
export function tokenizeV26(text: string): string[] {
  return normalizeTextV26(text)
    .split(/[^a-z0-9àáâãèéêìíòóôõùúýăâđêôơưàảãạảấầẩẫậắằẳẵặẹẻẽềềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+/u)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Block kind + registry
// ---------------------------------------------------------------------------

/**
 * Loai block.
 *  - `human`: biet ve user (Letta-style, 1 block/user).
 *  - `persona`: biet ve chinh agent (vai tro, giong dieu).
 *  - `task`: custom block cho 1 nhiem vu cu the.
 *  - `project`: custom block cho 1 du an (nhieu task, nhieu bot).
 *  - `custom`: block tu do khac (ghi ro muc dich o description).
 */
export type V26BlockKind = 'human' | 'persona' | 'task' | 'project' | 'custom';

export const V26_BLOCK_KINDS: readonly V26BlockKind[] = [
  'human',
  'persona',
  'task',
  'project',
  'custom',
];

export function isV26BlockKind(value: string): value is V26BlockKind {
  return (V26_BLOCK_KINDS as readonly string[]).includes(value);
}

/**
 * 1 muc registry cho 1 shared block.
 *
 * Registry la lop chi muc tren V25SharedBlockStore: block goc
 * van nam trong store v25 (value/version/history), registry
 * them thong tin quan tri — kind, template goc, budget token,
 * trang thai xung dot, so lan cap nhat — de list/tim/loc nhanh
 * ma khong phai quet tung block.
 *
 * Quy tac:
 *  - Moi block trong store v25 deu co 1 muc registry (tao dong
 *    bo khi createBlock; block cu import vao thi dang ky lai).
 *  - Label duy nhat trong scope (ke thua tu v25).
 *  - `human`/`persona`: moi scope chi nen co toi da 1 block
 *    moi loai — registry canh bao (warn, khong chan) khi tao
 *    block thu 2 cung kind chuan trong cung scope.
 */
export interface V26RegistryEntry {
  /** Id muc registry (khac block id). */
  id: string;
  /** Id block v25 tuong ung. */
  blockId: string;
  /** Label duy nhat trong scope (vd "human", "project-alpha"). */
  label: string;
  /** Loai block. */
  kind: V26BlockKind;
  /** Bot so huu block (ke thua tu block v25). */
  ownerBotId: string;
  /** Cac bot dang attach (ke thua tu block v25, dong bo moi lan doi). */
  attachedBotIds: string[];
  /** Template da dung de tao block ('' = khong dung template). */
  templateId: string;
  /** Gioi han token cua block (0 = khong gioi han). */
  tokenBudget: number;
  /** Block co xung dot chua giai quyet khong. */
  hasOpenConflict: boolean;
  /** Id xung dot dang mo ('' = khong co). */
  openConflictId: string;
  /** Tong so lan cap nhat (tinh ca curate/revert). */
  updateCount: number;
  /** Lan cap nhat gan nhat (ISO). */
  lastUpdatedAt: string;
  /** Bot cap nhat gan nhat. */
  lastUpdatedBy: string;
  /** Scope ke thua tu block v25. */
  scope: V25Scope;
  /** Thoi diem dang ky (ISO). */
  registeredAt: string;
}

/** Input tao block moi qua registry (mo rong input v25). */
export interface V26CreateBlockInput {
  label: string;
  description?: string;
  value: string;
  ownerBotId: string;
  kind?: V26BlockKind;
  templateId?: string;
  scope?: Partial<V25Scope>;
  readOnly?: boolean;
  maxChars?: number;
  attachBotIds?: string[];
  /** Gioi han token (0 = khong gioi han, mac dinh 0). */
  tokenBudget?: number;
}

/** Bo loc khi liet ke registry. */
export interface V26RegistryFilter {
  scope?: V25Scope;
  /** Chi block bot nay so huu hoac attach. */
  botId?: string;
  /** Chi block cua owner nay. */
  ownerBotId?: string;
  kind?: V26BlockKind;
  hasOpenConflict?: boolean;
  /** Tim theo label (khop 1 phan, khong phan biet hoa/thuong). */
  labelContains?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Hanh dong ghi vao audit log. */
export type V26AuditAction =
  | 'created'
  | 'write'
  | 'append'
  | 'replace'
  | 'curate'
  | 'revert'
  | 'attach'
  | 'detach'
  | 'transfer'
  | 'readonly'
  | 'budget'
  | 'template'
  | 'conflict'
  | 'resolved'
  | 'archived'
  | 'imported';

/**
 * 1 muc audit log (append-only, khong sua/xoa).
 *
 * Ghi day du: ai sua, khi nao, version cu -> moi, noi dung
 * cu/moi (cat ngan 2000 ky tu de log khong phong to vo han —
 * noi dung day du van nam trong history cua block v25).
 */
export interface V26AuditEntry {
  id: string;
  blockId: string;
  label: string;
  action: V26AuditAction;
  /** Ai thuc hien (bot id / 'user' / 'sleep-agent' / 'system'). */
  by: string;
  /** Thoi diem (ISO). */
  at: string;
  fromVersion: number;
  toVersion: number;
  /** Noi dung cu (cat ngan 2000 ky tu, '' neu khong co). */
  oldValue: string;
  /** Noi dung moi (cat ngan 2000 ky tu, '' neu khong co). */
  newValue: string;
  /** Ly do doc duoc (vd "write", "curate: over budget"). */
  reason: string;
  /** Id xung dot lien quan ('' neu khong co). */
  conflictId: string;
}

/** Bo loc khi liet ke audit log. */
export interface V26AuditFilter {
  blockId?: string;
  label?: string;
  by?: string;
  action?: V26AuditAction;
  /** Chi muc tu ngay nay (day key YYYY-MM-DD, lay theo UTC). */
  fromDay?: string;
  /** Chi muc den ngay nay (day key YYYY-MM-DD, lay theo UTC). */
  toDay?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

/** Trang thai xung dot. */
export type V26ConflictStatus = 'open' | 'resolved';

/** Cach giai quyet xung dot. */
export type V26ConflictResolution = 'keep-current' | 'keep-incoming' | 'merge-lines' | 'manual';

/**
 * Xung dot khi 2 agent sua cung block.
 *
 * Co che: moi lan ghi phai kem `expectedVersion` (version ma
 * agent da doc). Neu version hien tai khac expectedVersion thi
 * ghi bi tu choi + tao conflict ghi lai day du 3 phia:
 * base (gia tri luc agent doc), current (gia tri tren store
 * luc nay), incoming (gia tri agent dinh ghi). Agent khac
 * (hoac user) giai quyet sau — khong mat du lieu ben nao.
 */
export interface V26Conflict {
  id: string;
  blockId: string;
  label: string;
  /** Version ma agent ghi dua tren (base). */
  baseVersion: number;
  /** Version hien tai tren store luc phat hien. */
  currentVersion: number;
  /** Version ma ban ghi dinh tao (currentVersion + 1 neu duoc chap nhan). */
  incomingVersion: number;
  /** Gia tri luc agent doc (base). */
  baseValue: string;
  /** Gia tri hien tai tren store. */
  currentValue: string;
  /** Gia tri agent dinh ghi. */
  incomingValue: string;
  /** Agent gay xung dot (ghi sau, bi tu choi). */
  by: string;
  /** Agent da ghi ban current (ghi truoc, thang). */
  currentBy: string;
  /** Thoi diem phat hien (ISO). */
  detectedAt: string;
  status: V26ConflictStatus;
  /** Cach da giai quyet ('' neu chua giai quyet). */
  resolution: V26ConflictResolution | '';
  /** Ai giai quyet. */
  resolvedBy: string;
  /** Thoi diem giai quyet (ISO, '' neu chua). */
  resolvedAt: string;
  /** Ghi chu khi giai quyet. */
  resolutionNote: string;
  /** Version block sau khi giai quyet (0 neu chua). */
  resolvedVersion: number;
}

/** Ket qua ghi bi xung dot — tra ve thay vi chi loi chuoi. */
export interface V26WriteConflictResult {
  conflict: V26Conflict;
  /** Gia tri hien tai tren store (de agent doc lai). */
  currentValue: string;
  currentVersion: number;
}

// ---------------------------------------------------------------------------
// Budget + curation
// ---------------------------------------------------------------------------

/** Cau hinh budget token cua 1 block. */
export interface V26BlockBudget {
  blockId: string;
  label: string;
  /** Gioi han token (0 = khong gioi han). */
  maxTokens: number;
  /** Ti le canh bao (0..1, mac dinh 0.8): vuot ti le nay thi status 'warn'. */
  warnRatio: number;
  /** Khi vuot budget thi tu curate hay chi canh bao ('curate' | 'warn'). */
  onExceed: 'curate' | 'warn';
  /** Token dich khi curate: tom tat ve toi da bao nhieu token. */
  curateTargetTokens: number;
}

/** Cau hinh budget mac dinh. */
export const V26_DEFAULT_BUDGET: Readonly<Omit<V26BlockBudget, 'blockId' | 'label'>> = {
  maxTokens: 0,
  warnRatio: 0.8,
  onExceed: 'warn',
  curateTargetTokens: 1000,
};

/** Trang thai budget cua 1 block tai 1 thoi diem. */
export interface V26BudgetStatus {
  blockId: string;
  label: string;
  /** Token hien tai (estimate). */
  tokens: number;
  /** Gioi han token (0 = khong gioi han). */
  maxTokens: number;
  /** Ti le su dung 0..1 (0 neu khong gioi han). */
  usageRatio: number;
  status: 'ok' | 'warn' | 'over' | 'unlimited';
  /** Co can curate ngay khong. */
  needsCurate: boolean;
  /** So token vuot (0 neu khong vuot). */
  overByTokens: number;
}

/** 1 y (don vi nho nhat) trong summarise: dong/cau duoc giu hoac bo. */
export interface V26SummaryItem {
  /** Text cua y (1 dong hoac 1 cau). */
  text: string;
  /** Diem quan trong 0..1 (tu khoa lap lai + vi tri + dinh dang). */
  score: number;
  /** Co duoc giu trong ban tom tat khong. */
  kept: boolean;
  /** Ly do giu/bo doc duoc (vd "keyword: deadline", "lap lai"). */
  reason: string;
}

/** Ket qua ham summarise (extractive, local). */
export interface V26SummariseResult {
  /** Text tom tat (cac y duoc giu, giu nguyen thu tu goc). */
  summary: string;
  /** Token cua ban goc (estimate). */
  originalTokens: number;
  /** Token cua ban tom tat (estimate). */
  summaryTokens: number;
  /** So y goc / so y duoc giu. */
  itemsTotal: number;
  itemsKept: number;
  /** Chi tiet tung y (de test + giai thich). */
  items: V26SummaryItem[];
  /** Ban tom tat co giu duoc heading/muc chinh khong. */
  keptHeadings: string[];
}

/** Bao cao 1 lan curate block. */
export interface V26CurateReport {
  blockId: string;
  label: string;
  at: string;
  by: string;
  fromVersion: number;
  toVersion: number;
  originalTokens: number;
  summaryTokens: number;
  tokensSaved: number;
  itemsTotal: number;
  itemsKept: number;
  /** Curate co that su ghi block moi khong (false neu da gon). */
  applied: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Archival + recall
// ---------------------------------------------------------------------------

/** Loai muc luu tru. */
export type V26ArchiveKind = 'block-version' | 'fact' | 'turn' | 'note' | 'curated-out';

/**
 * 1 muc trong kho luu tru (archival memory).
 *
 * Moi version cu cua block, moi fact het hieu luc, moi turn
 * hoi thoai cu deu co the dua vao day — khong xoa, chi chuyen
 * khoi core memory de core luon gon. Search theo ngay + noi
 * dung, recall theo ngay.
 */
export interface V26ArchiveEntry {
  id: string;
  kind: V26ArchiveKind;
  /** Block nguon ('' neu khong gan block). */
  sourceBlockId: string;
  /** Label block nguon ('' neu khong co). */
  sourceLabel: string;
  /** Noi dung luu tru. */
  content: string;
  /** Thoi diem noi dung duoc tao (ISO). */
  at: string;
  /** Day key YYYY-MM-DD (UTC) cua `at` — khoa tim theo ngay. */
  dayKey: string;
  /** Version block luc luu tru (0 neu khong phai block-version). */
  version: number;
  /** Tag tu do (vd "deadline", "quyet-dinh"). */
  tags: string[];
  /** Bot/user tao ra noi dung goc. */
  by: string;
  /** Ghi chu khi luu tru (vd "version cu truoc khi curate"). */
  note: string;
}

/** Input them muc luu tru. */
export interface V26ArchiveInput {
  kind: V26ArchiveKind;
  sourceBlockId?: string;
  sourceLabel?: string;
  content: string;
  /** Thoi diem noi dung (ISO, mac dinh now). */
  at?: string;
  tags?: string[];
  by?: string;
  note?: string;
  version?: number;
}

/** Bo loc search archival. */
export interface V26ArchiveSearchFilter {
  /** Tu khoa (khop 1 phan vao content/tags/label, khong phan biet hoa). */
  query?: string;
  /** Chi muc tu ngay nay (day key). */
  fromDay?: string;
  /** Chi muc den ngay nay (day key). */
  toDay?: string;
  kind?: V26ArchiveKind;
  sourceBlockId?: string;
  sourceLabel?: string;
  tag?: string;
  by?: string;
  limit?: number;
}

/** 1 ket qua search archival (co diem). */
export interface V26ArchiveHit {
  entry: V26ArchiveEntry;
  /** Diem 0..1 (khop tu khoa + gan ngay neu co). */
  score: number;
  /** Giai thich diem doc duoc. */
  explanation: string;
}

/** Ket qua recall theo ngay. */
export interface V26RecallDay {
  /** Day key duoc hoi. */
  dayKey: string;
  /** So muc trong ngay do. */
  total: number;
  /** Cac muc trong ngay (moi nhat truoc). */
  entries: V26ArchiveEntry[];
  /** Ngay ke truoc co muc ('' neu khong co trong kho). */
  prevDayWithEntries: string;
  /** Ngay ke sau co muc ('' neu khong co trong kho). */
  nextDayWithEntries: string;
  /** Tom tat 1 dong. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/**
 * 1 template tao block.
 *
 * Template dinh nghia cau truc block: cac truong bat buoc (co
 * trong value duoi dang heading/bullet), gia tri mac dinh, mo
 * ta, budget goi y. Khoi tao block tu template giup cac bot
 * dung chung 1 dinh dang — doc block cua nhau khong phai doan.
 */
export interface V26BlockTemplate {
  /** Id template (vd "human", "persona", "task", "project"). */
  id: string;
  /** Loai block template nay tao ra. */
  kind: V26BlockKind;
  /** Ten hien thi. */
  name: string;
  /** Mo ta template. */
  description: string;
  /** Cac truong bat buoc — moi truong la 1 heading trong value. */
  requiredFields: string[];
  /** Cac truong tuy chon. */
  optionalFields: string[];
  /** Gia tri mau day du (dung lam value khoi tao). */
  defaultValue: string;
  /** Budget token goi y (0 = khong goi y). */
  suggestedBudgetTokens: number;
  /** Template co san (built-in) hay do user tu tao. */
  builtin: boolean;
  /** Thoi diem tao template (ISO). */
  createdAt: string;
}

/** Input dang ky template tu tao. */
export interface V26TemplateInput {
  id: string;
  kind: V26BlockKind;
  name: string;
  description?: string;
  requiredFields?: string[];
  optionalFields?: string[];
  defaultValue: string;
  suggestedBudgetTokens?: number;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/** Gioi han quota cho 1 bot. */
export interface V26BotQuota {
  /** So block toi da 1 bot duoc so huu. */
  maxOwnedBlocks: number;
  /** So block toi da 1 bot duoc attach (tinh ca block so huu). */
  maxAttachedBlocks: number;
  /** Tong token toi da tren cac block bot so huu (0 = khong gioi han). */
  maxOwnedTokens: number;
  /** Tong ky tu toi da tren cac block bot so huu (0 = khong gioi han). */
  maxOwnedChars: number;
}

/** Quota mac dinh (rong rai, chi chong lam dung). */
export const V26_DEFAULT_QUOTA: Readonly<V26BotQuota> = {
  maxOwnedBlocks: 50,
  maxAttachedBlocks: 200,
  maxOwnedTokens: 50000,
  maxOwnedChars: 200000,
};

/** Muc su dung quota cua 1 bot tai 1 thoi diem. */
export interface V26BotQuotaUsage {
  botId: string;
  ownedBlocks: number;
  attachedBlocks: number;
  ownedTokens: number;
  ownedChars: number;
  quota: V26BotQuota;
  /** Bot co vuot gioi han nao khong. */
  over: string[];
  /** Ti le su dung lon nhat trong cac gioi han (0..1+, >1 la vuot). */
  maxUsageRatio: number;
}

// ---------------------------------------------------------------------------
// Stats / health / snapshot
// ---------------------------------------------------------------------------

/** Thong ke store v26. */
export interface V26Stats {
  blocksTotal: number;
  blocksByKind: Record<V26BlockKind, number>;
  blocksWithOpenConflict: number;
  attachedTotal: number;
  auditTotal: number;
  conflictsTotal: number;
  conflictsOpen: number;
  conflictsResolved: number;
  archivedTotal: number;
  archivedByKind: Record<V26ArchiveKind, number>;
  templatesTotal: number;
  templatesBuiltin: number;
  curationsTotal: number;
  tokensSavedByCuration: number;
  blocksOverBudget: number;
  blocksWarnBudget: number;
}

/** 1 muc health check. */
export interface V26Health {
  severity: 'info' | 'warn' | 'error';
  code: string;
  detail: string;
}

/** Snapshot store de luu/load JSON. */
export interface V26StoreSnapshot {
  version: 26;
  exportedAt: string;
  blocks: V25SharedBlock[];
  registry: V26RegistryEntry[];
  audit: V26AuditEntry[];
  conflicts: V26Conflict[];
  archive: V26ArchiveEntry[];
  budgets: V26BlockBudget[];
  templates: V26BlockTemplate[];
  quota: V26BotQuota;
  curations: V26CurateReport[];
}

/** 1 dong render block trong prompt (co budget). */
export interface V26PromptBlock {
  label: string;
  kind: V26BlockKind;
  value: string;
  tokens: number;
  truncated: boolean;
}

/** Ket qua render prompt co budget tong. */
export interface V26PromptSnapshot {
  text: string;
  chars: number;
  tokens: number;
  budgetTokens: number;
  blocksRendered: number;
  blocksSkipped: number;
  blocksTruncated: string[];
  blocks: V26PromptBlock[];
}

/** Kiem tra label block hop le: [a-z0-9_-], 1..64 ky tu. */
export function isValidBlockLabelV26(label: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(label);
}

/** Kiem tra id template hop le: [a-z0-9_-], 1..64 ky tu. */
export function isValidTemplateIdV26(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

/**
 * Kiem tra cau hinh budget hop le — tra loi neu sai.
 */
export function validateBudgetV26(budget: Partial<V26BlockBudget>): string | null {
  if (budget.maxTokens !== undefined) {
    if (!Number.isInteger(budget.maxTokens) || budget.maxTokens < 0 || budget.maxTokens > 1000000) {
      return 'maxTokens phai la so nguyen 0..1000000 (0 = khong gioi han).';
    }
  }
  if (budget.warnRatio !== undefined) {
    if (typeof budget.warnRatio !== 'number' || !Number.isFinite(budget.warnRatio) || budget.warnRatio <= 0 || budget.warnRatio > 1) {
      return 'warnRatio phai la so 0..1 (khong tinh 0).';
    }
  }
  if (budget.onExceed !== undefined && budget.onExceed !== 'curate' && budget.onExceed !== 'warn') {
    return 'onExceed phai la "curate" hoac "warn".';
  }
  if (budget.curateTargetTokens !== undefined) {
    if (!Number.isInteger(budget.curateTargetTokens) || budget.curateTargetTokens < 1 || budget.curateTargetTokens > 1000000) {
      return 'curateTargetTokens phai la so nguyen 1..1000000.';
    }
  }
  if (
    budget.maxTokens !== undefined &&
    budget.maxTokens > 0 &&
    budget.curateTargetTokens !== undefined &&
    budget.curateTargetTokens >= budget.maxTokens
  ) {
    return 'curateTargetTokens phai nho hon maxTokens.';
  }
  return null;
}

/** Kiem tra quota hop le — tra loi neu sai. */
export function validateQuotaV26(quota: Partial<V26BotQuota>): string | null {
  const fields: Array<[keyof V26BotQuota, number, number]> = [
    ['maxOwnedBlocks', 1, 10000],
    ['maxAttachedBlocks', 1, 10000],
    ['maxOwnedTokens', 0, 10000000],
    ['maxOwnedChars', 0, 40000000],
  ];
  for (const [key, min, max] of fields) {
    const value = quota[key];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
      return `${key} phai la so nguyen ${min}..${max}.`;
    }
  }
  if (
    quota.maxOwnedBlocks !== undefined &&
    quota.maxAttachedBlocks !== undefined &&
    quota.maxAttachedBlocks < quota.maxOwnedBlocks
  ) {
    return 'maxAttachedBlocks khong duoc nho hon maxOwnedBlocks.';
  }
  return null;
}

/** Kiem tra 1 ngay co nam trong [fromDay, toDay] khong (rong = khong gioi han). */
export function dayInRangeV26(dayKey: string, fromDay?: string, toDay?: string): boolean {
  if (fromDay && dayKey < fromDay) return false;
  if (toDay && dayKey > toDay) return false;
  return true;
}
