/**
 * Memory v28 — types (v1.44, Doi T1).
 *
 * Y tuong hoc tu survey v144 muc 2-3 (Letta v0.16.7 MemFS + Mem0 v3
 * + mnemograph, chi y tuong, KHONG copy code/text/tai san cua bat
 * ky repo nao):
 *  - Letta MemFS: memory block la file co version trong repo git
 *    rieng — history/diff/rollback co san tu git.
 *  - Letta Conversations API: nhieu bot doc/ghi chung mot block,
 *    co quyen truy cap theo bot.
 *  - Letta sleep-time agents: consolidation chay nhu subagent
 *    phia client khi ranh, khong chen vao turn dang chay.
 *  - Mem0 v3 / Zep / Graphiti: fact cu bi VO HIEU (invalidate)
 *    chu khong xoa — giu lai kem cua so hieu luc (bi-temporal).
 *  - mnemograph: event-sourced knowledge graph, version bang git,
 *    time-travel reads `get_state_at` / `diff_timerange`.
 *
 * Khac biet voi v27 (v27 da co: add-only single-pass extraction,
 * entity linking luc ghi, fact graph bi-temporal, episode
 * provenance, time-travel chat, shared block bi-temporal):
 *  - v28 dua block XUONG GIT THAT: moi block la file Markdown
 *    trong repo git rieng (`.open-bot/memory-v28/`), moi lan ghi
 *    la 1 commit — history/diff/rollback dung git, khong phai
 *    timeline JSON tu che. Khi may khong co git thi roi ve
 *    history JSONL append-only (giong v7).
 *  - v28 them ACL theo bot cho shared block: read/write/admin/
 *    none, audit log moi lan cap quyen va moi lan ghi.
 *  - v28 them sleep-time consolidation dang subagent phia
 *    client: chay khi ranh (quiet hours + idle), gom/khu trung/
 *    tom tat, xung dot thi supersede fact cu (invalidate, khong
 *    xoa) — khong bao gio chay trong turn.
 *  - v28 mo rong time-travel: `get_state_at(timestamp)` tra ve
 *    TOAN BO trang thai memory (block + fact) tai X, va
 *    `diff_timerange(from, to)` liet ke moi thay doi trong
 *    khoang — ca block (qua git) va fact (qua cua so hieu luc).
 *
 * Chay 100% local: khong goi model chat, khong goi API ngoai.
 * Git chi goi binary `git` local (neu co). Khong co ham xoa
 * vat ly nao: block chi archive, fact chi invalidate.
 */
import { createHash } from 'node:crypto';

/** Phien ban memory v28. */
export const V28_VERSION = '28.0.0';

/** Ten thu muc goc cua memory v28 trong workspace. */
export const V28_ROOT_DIR_NAME = 'memory-v28';

/** Ten thu muc chua file block trong repo git v28. */
export const V28_BLOCKS_DIR_NAME = 'blocks';

/** Ten file lich su du phong (khi may khong co git). */
export const V28_HISTORY_FILENAME = 'history.jsonl';

/** Ten file luu fact bi-temporal (append-only JSONL). */
export const V28_FACTS_FILENAME = 'facts.jsonl';

/** Ten file luu ACL cua shared block. */
export const V28_ACL_FILENAME = 'acl.json';

/** Ten file luu audit log cua shared block. */
export const V28_AUDIT_FILENAME = 'audit.jsonl';

/** Ten file luu snapshot cua store v28. */
export const V28_STORE_FILENAME = 'memory-v28-store.json';

/** Ten file luu trang thai sleep consolidation. */
export const V28_SLEEP_STATE_FILENAME = 'memory-v28-sleep.json';

/** Gioi han cung cua v28. */
export const V28_LIMITS = {
  /** So ky tu toi da cua mot block. */
  maxBlockChars: 200_000,
  /** So ky tu toi da cua mot fact text. */
  maxFactChars: 4_000,
  /** So version lich su tra ve mac dinh. */
  defaultHistoryLimit: 50,
  /** So version lich su toi da cho phep yeu cau. */
  maxHistoryLimit: 500,
  /** So fact toi da mot lan sleep run duoc ghi. */
  defaultMaxFactsPerRun: 50,
  /** So fact toi da cho phep cau hinh mot lan sleep run. */
  maxFactsPerRun: 500,
  /** So episode toi da mot lan sleep run quet. */
  maxEpisodesPerRun: 200,
  /** So muc diff toi da tra ve. */
  maxDiffEntries: 1_000,
  /** So muc audit toi da tra ve. */
  maxAuditEntries: 500,
  /** Do dai toi da cua mot label block. */
  maxLabelLength: 80,
  /** Nguong Jaccard de coi 2 fact la trung nhau (sleep dedupe). */
  defaultDedupeThreshold: 0.72,
  /** So phut idle toi thieu truoc khi sleep run duoc chay. */
  defaultMinIdleMinutes: 15,
} as const;

/** Loai block memory v28. */
export type V28BlockKind = 'human' | 'persona' | 'note' | 'fact' | 'shared' | 'custom';

/** Pham vi block: `system` chi user/he thong sua, `user` bot duoc sua (qua tool + approval). */
export type V28BlockScope = 'system' | 'user' | 'shared';

/** Quyen truy cap cua mot bot tren shared block. */
export type V28AclRole = 'none' | 'read' | 'write' | 'admin';

/** Trang thai cua mot fact bi-temporal. */
export type V28FactStatus = 'active' | 'invalidated' | 'superseded';

/** Ly do mot fact bi vo hieu. */
export type V28InvalidateReason =
  | 'superseded'
  | 'contradicted'
  | 'outdated'
  | 'incorrect'
  | 'duplicate'
  | 'user-request'
  | 'sleep-consolidation';

/** Loai thay doi trong diff_timerange. */
export type V28DiffChange = 'added' | 'removed' | 'changed' | 'invalidated' | 'restored';

/** Loai muc trong diff_timerange: block hay fact. */
export type V28DiffKind = 'block' | 'fact';

/** Ket qua tra ve kieu Result — loi la chuoi, khong throw qua bien module. */
export type V28Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Tao Result thanh cong. */
export function okV28<T>(value: T): V28Result<T> {
  return { ok: true, value };
}

/** Tao Result loi. */
export function errV28<T = never>(error: string): V28Result<T> {
  return { ok: false, error };
}

/** Meta cua mot block (doc tu frontmatter + git). */
export interface V28BlockMeta {
  label: string;
  kind: V28BlockKind;
  description: string;
  scope: V28BlockScope;
  readOnly: boolean;
  /** Bot so huu block (bot tao ra no). */
  ownerBotId: string;
  /** So version (tang 1 moi lan ghi). */
  version: number;
  /** Hash SHA-256 cua noi dung hien tai. */
  hash: string;
  /** Commit git cua version hien tai (rong khi chay fallback khong git). */
  commit: string;
  createdAt: string;
  updatedAt: string;
}

/** Mot version trong lich su cua block. */
export interface V28BlockVersion {
  label: string;
  version: number;
  /** Hash SHA-256 cua noi dung tai version nay. */
  hash: string;
  /** Commit git (rong khi chay fallback khong git). */
  commit: string;
  /** Commit cha (rong voi version dau tien). */
  parentCommit: string;
  author: string;
  message: string;
  createdAt: string;
  contentLength: number;
}

/** Mot block day du: meta + noi dung. */
export interface V28Block {
  meta: V28BlockMeta;
  content: string;
}

/** Mot muc ACL: bot nao co quyen gi tren block nao. */
export interface V28AclEntry {
  label: string;
  botId: string;
  role: V28AclRole;
  grantedBy: string;
  grantedAt: string;
}

/** Mot muc audit log cua shared block. */
export interface V28AuditEntry {
  at: string;
  label: string;
  actor: string;
  action: 'create' | 'grant' | 'revoke' | 'attach' | 'detach' | 'write' | 'rollback' | 'archive';
  detail: string;
  /** Version block sau hanh dong (neu co). */
  version?: number;
}

/** Shared block: block git + ACL + danh sach bot attach. */
export interface V28SharedBlock {
  label: string;
  meta: V28BlockMeta;
  content: string;
  /** Bot so huu (luon co quyen admin). */
  ownerBotId: string;
  attachedBots: string[];
  acl: V28AclEntry[];
}

/** Fact bi-temporal: giu lai mai mai, chi dong cua so hieu luc. */
export interface V28Fact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  /** Cau text goc day du cua fact. */
  text: string;
  source: 'user' | 'agent' | 'system' | 'sleep-agent' | 'import';
  /** Episode goc (neu co) — provenance. */
  episodeId?: string;
  botId: string;
  /** Scope giong v25: user/agent/run/app tuy chon. */
  userId?: string;
  agentId?: string;
  runId?: string;
  appId?: string;
  confidence: number;
  tags: string[];
  /** Transaction time: he thong biet fact tu luc nay. */
  createdAt: string;
  updatedAt: string;
  /** Valid time: fact dung tu luc nay... */
  validFrom: string;
  /** ...den luc nay (null = van dung). */
  validTo: string | null;
  /** Luc fact bi vo hieu (null = chua bi vo hieu). */
  invalidatedAt: string | null;
  invalidatedBy?: string;
  invalidateReason?: V28InvalidateReason;
  /** Id fact moi thay the fact nay (khi supersede). */
  supersededBy?: string;
  status: V28FactStatus;
}

/** Du lieu dau vao de them mot fact moi. */
export interface V28FactInput {
  subject: string;
  predicate: string;
  object: string;
  text?: string;
  source?: V28Fact['source'];
  episodeId?: string;
  botId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  appId?: string;
  confidence?: number;
  tags?: string[];
  /** Valid time bat dau (mac dinh = bay gio). */
  validFrom?: string;
}

/** Cau hinh sleep-time consolidation. */
export interface V28SleepConfig {
  /** Mac dinh TAT — khong chay neu user/agent khong bat. */
  enabled: boolean;
  /** Gio bat dau quiet hours (0-23, gio dia phuong cua may). */
  quietHoursStart: number;
  /** Gio ket thuc quiet hours (0-23). */
  quietHoursEnd: number;
  /** Chi chay trong quiet hours? false = chay bat cu khi nao idle du. */
  onlyInQuietHours: boolean;
  /** So phut idle toi thieu truoc khi chay. */
  minIdleMinutes: number;
  /** So fact toi da duoc ghi trong mot run. */
  maxFactsPerRun: number;
  /** Nguong Jaccard de khu trung (0-1). */
  dedupeThreshold: number;
  /** Block shared nao nhan ban tom tat (mac dinh `human`). */
  summaryBlockLabel: string;
  /** Bot nao duoc phep chay sleep run (rong = moi bot). */
  allowedBotIds: string[];
}

/** Mot episode/candidate dau vao cho sleep consolidation. */
export interface V28SleepEpisode {
  id: string;
  text: string;
  botId: string;
  at: string;
}

/** Mot candidate fact trich xuat duoc trong sleep run. */
export interface V28SleepCandidate {
  subject: string;
  predicate: string;
  object: string;
  text: string;
  confidence: number;
  episodeId: string;
  /** Ly do trich xuat (pattern nao khop). */
  pattern: string;
}

/** Bao cao mot lan sleep run. */
export interface V28SleepRunReport {
  runId: string;
  botId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  episodesScanned: number;
  candidatesExtracted: number;
  duplicatesSkipped: number;
  factsAdded: number;
  factsInvalidated: number;
  factsSuperseded: number;
  summaryPromoted: boolean;
  summaryBlockLabel: string;
  skippedReason?: string;
  errors: string[];
  /** Ghi chu doc duoc: moi dong tom tat mot quyet dinh. */
  notes: string[];
}

/** Trang thai memory tai mot thoi diem (ket qua get_state_at). */
export interface V28TimeTravelState {
  at: string;
  blocks: Array<{
    label: string;
    version: number;
    commit: string;
    hash: string;
    content: string;
    updatedAt: string;
  }>;
  facts: V28Fact[];
}

/** Mot muc thay doi trong diff_timerange. */
export interface V28DiffEntry {
  kind: V28DiffKind;
  /** Label block hoac id fact. */
  key: string;
  change: V28DiffChange;
  at: string;
  /** Tom tat ngan ve thay doi (khong chua noi dung day du). */
  summary: string;
  fromVersion?: number;
  toVersion?: number;
  fromHash?: string;
  toHash?: string;
}

/** Ket qua diff_timerange. */
export interface V28DiffRange {
  from: string;
  to: string;
  entries: V28DiffEntry[];
  blocksAdded: number;
  blocksRemoved: number;
  blocksChanged: number;
  factsAdded: number;
  factsInvalidated: number;
}

/** Thong ke tong hop cua memory v28. */
export interface V28Stats {
  blocksTotal: number;
  sharedBlocksTotal: number;
  versionsTotal: number;
  commitsTotal: number;
  factsTotal: number;
  factsActive: number;
  factsInvalidated: number;
  factsSuperseded: number;
  gitAvailable: boolean;
  fallbackMode: boolean;
  sleepRunsTotal: number;
  lastSleepRunAt: string | null;
  aclEntriesTotal: number;
  auditEntriesTotal: number;
}

/** View cho panel UI cua memory v28. */
export interface V28PanelView {
  title: string;
  gitAvailable: boolean;
  fallbackMode: boolean;
  blocks: Array<{
    label: string;
    kind: V28BlockKind;
    version: number;
    commit: string;
    updatedAt: string;
    shared: boolean;
    attachedBots: string[];
  }>;
  factsActive: number;
  factsInvalidated: number;
  lastSleepRun: V28SleepRunReport | null;
  sleepEnabled: boolean;
  warnings: string[];
}

/** Cau hinh cua V28Store (facade). */
export interface V28StoreConfig {
  /** Thu muc workspace: memory v28 luu tai `<rootDir>/memory-v28/`. */
  rootDir?: string;
  botId?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  sleep?: Partial<V28SleepConfig>;
}

/** Snapshot JSON cua store v28 (block nam trong git, khong nam o day). */
export interface V28StoreSnapshot {
  version: string;
  exportedAt: string;
  facts: V28Fact[];
  acl: V28AclEntry[];
  audit: V28AuditEntry[];
  sleepConfig: V28SleepConfig;
  lastSleepRun: V28SleepRunReport | null;
  sleepRunsTotal: number;
}

/** Cau hinh mac dinh cua sleep consolidation. */
export const DEFAULT_V28_SLEEP_CONFIG: V28SleepConfig = {
  enabled: false,
  quietHoursStart: 1,
  quietHoursEnd: 5,
  onlyInQuietHours: false,
  minIdleMinutes: V28_LIMITS.defaultMinIdleMinutes,
  maxFactsPerRun: V28_LIMITS.defaultMaxFactsPerRun,
  dedupeThreshold: V28_LIMITS.defaultDedupeThreshold,
  summaryBlockLabel: 'human',
  allowedBotIds: [],
};

/** Thu tu quyen: so lon hon = quyen cao hon. */
export const V28_ROLE_RANK: Record<V28AclRole, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

/** Tao id duy nhat co tien to (deterministic theo thoi gian + bo dem). */
let v28IdCounter = 0;
export function makeV28Id(prefix: string): string {
  v28IdCounter = (v28IdCounter + 1) % 1_000_000;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${String(v28IdCounter).padStart(4, '0')}`;
}

/** Chuyen Date/ISO ve chuoi ISO day du; tra null khi khong parse duoc. */
export function isoAtV28(value: string | Date | number): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Parse ISO ve ms epoch; tra null khi khong parse duoc. */
export function parseIsoV28(value: string | Date | number): number | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

/** Hash SHA-256 hex cua mot chuoi (dung de phat hien doi noi dung). */
export function hashContentV28(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Chuan hoa text: trim, gom khoang trang, ha chu cai de so sanh. */
export function normalizeTextV28(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Tach token de so sanh tuong dong (bo dau cau, bo stopword ngan). */
export function tokenizeV28(text: string): string[] {
  return normalizeTextV28(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Do tuong dong Jaccard giua 2 tap token (0-1). */
export function jaccardV28(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/** Kiem tra label block hop le: chu cai/so/`-`/`_`, bat dau bang chu cai. */
export function isValidBlockLabelV28(label: string): boolean {
  if (!label || label.length > V28_LIMITS.maxLabelLength) return false;
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(label);
}

/** Chuan hoa label: trim + thay khoang trang/dau cham bang `-`, bo ky tu la. */
export function normalizeBlockLabelV28(label: string): string {
  return label
    .trim()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/^-+/, '');
}

/** Kiem tra mot fact co dung tai thoi diem `atMs` khong (valid time). */
export function factValidAtV28(fact: V28Fact, atMs: number): boolean {
  const from = parseIsoV28(fact.validFrom);
  if (from === null || from > atMs) return false;
  if (fact.validTo === null) return true;
  const to = parseIsoV28(fact.validTo);
  return to !== null && atMs < to;
}

/** Kiem tra he thong da biet fact tai thoi diem `atMs` chua (transaction time). */
export function factKnownAtV28(fact: V28Fact, atMs: number): boolean {
  const created = parseIsoV28(fact.createdAt);
  if (created === null || created > atMs) return false;
  if (fact.invalidatedAt === null) return true;
  const invalidated = parseIsoV28(fact.invalidatedAt);
  return invalidated !== null && atMs < invalidated;
}

/** Kiem tra gio dia phuong co nam trong quiet hours khong (xu ly qua nua dem). */
export function isQuietHoursV28(config: V28SleepConfig, at: Date): boolean {
  const hour = at.getHours();
  const { quietHoursStart, quietHoursEnd } = config;
  if (quietHoursStart === quietHoursEnd) return true;
  if (quietHoursStart < quietHoursEnd) return hour >= quietHoursStart && hour < quietHoursEnd;
  return hour >= quietHoursStart || hour < quietHoursEnd;
}
