/**
 * Memory v22 — Dreaming consolidation: types (v1.37, Doi T1).
 *
 * Y tuong hoc tu Anthropic "Dreams for Claude Managed Agents"
 * (06/11/2026), Mem0 Dream (04/08/2026), Letta dreaming /
 * sleep-time compute (Lin et al., arXiv 2504.13171) va bai
 * "Agent Memory Consolidation" (maximem.ai, 13/11/2026) — tu
 * thiet ke lai hoan toan cho open-bot, KHONG copy code/text/tai
 * san cua bat ky repo nao.
 *
 * Mot "dream" (giac mo) la mot luot chay nen, ngoai critical
 * path cua chat, doc lai nhung gi agent da luu (+ transcript
 * gan day do host day vao) va viet lai ban sach hon:
 *   1. gop fact trung lap (dedupe theo Jaccard token),
 *   2. supersede fact bi mau thuan (fact moi manh hon thang,
 *      ghi ro ai thang va vi sao; yeu hon qua nguong thi giu
 *      ban cu va dua vao danh sach can xem lai),
 *   3. het han fact co thoi han (validUntil — chi danh dau
 *      `expired`, KHONG xoa: lich su van con de truy vet),
 *   4. tong hop pattern lap lai thanh fact ben (fact xuat hien
 *      o nhieu session / nhieu lan quan sat),
 *   5. xay wiki representation (trang theo chu de + link),
 *   6. giu lop always-loaded duoi ngan sach ky tu (do truoc /
 *      sau dream, cat co ly do),
 *   7. moi thay doi revert duoc (snapshot truoc dream + audit
 *      log append-only + lenh rollback khoi phuc dung snapshot).
 *
 * Khong goi model, khong goi mang. Moi loi o mot phase chi ghi
 * vao report (fail-open theo phase); loi nghiem trong thi dream
 * tu rollback ve snapshot va bao `rolledBack: true`.
 *
 * QUY UOC TEN: moi export deu bat dau bang `V22` de khong dung
 * voi `DreamFact` / `DreamRunReport` / `DeepDreamEngine` da co
 * trong `packages/core/src/memory/dream.ts` (memory v4).
 */

/** Loi dreaming consolidation v22 — message tieng Viet. */
export class V22DreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V22DreamError';
  }
}

/** Loai fact trong dream store. */
export type V22FactKind =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'observation'
  | 'pattern'
  | 'note';

export const V22_FACT_KINDS: readonly V22FactKind[] = [
  'fact',
  'preference',
  'decision',
  'observation',
  'pattern',
  'note',
];

/** Trang thai cua mot fact trong dream store. */
export type V22FactStatus =
  | 'active'
  | 'superseded'
  | 'expired'
  | 'merged'
  | 'invalidated';

export const V22_FACT_STATUSES: readonly V22FactStatus[] = [
  'active',
  'superseded',
  'expired',
  'merged',
  'invalidated',
];

/** Nguon goc cua mot fact. */
export type V22FactOrigin = 'chat' | 'tool' | 'import' | 'dream' | 'pattern';

/**
 * Mot fact trong dream store.
 *
 * `topic` + `value` la cap khoa co cau truc de phat hien mau
 * thuan mot cach xac dinh (khong can model): hai fact cung
 * `topic`, `value` chuan hoa khac nhau thi mau thuan nhau
 * (vd topic `user|thich_uong`, value `ca-phe-den` vs
 * `tra-dao`). Fact khong co topic/value thi chi tham gia
 * dedupe theo text, khong tham gia supersede.
 */
export interface V22DreamFact {
  /** Id duy nhat trong store (vd `dream-fact-1`). */
  id: string;
  kind: V22FactKind;
  /** Noi dung day du (mot cau / mot doan ngan). */
  text: string;
  /** Chu de co cau truc (vd `user|thich_uong`). Tuy chon. */
  topic?: string;
  /** Gia tri co cau truc cua chu de (vd `ca-phe-den`). Tuy chon. */
  value?: string;
  /** Do tin cay 0..1. */
  confidence: number;
  status: V22FactStatus;
  /** Nguon goc (chat:session-..., tool:..., dream:job-...). */
  sources: string[];
  tags: string[];
  /** Cac session da quan sat fact nay. */
  sessionIds: string[];
  /** Epoch ms quan sat lan dau / cap nhat lan cuoi. */
  observedAt: number;
  updatedAt: number;
  /** Epoch ms bat dau co hieu luc (tuy chon). */
  validFrom?: number;
  /** Epoch ms het hieu luc (tuy chon) — qua moc nay fact het han. */
  validUntil?: number;
  /** Id cac fact ma fact nay da thay the. */
  supersedes: string[];
  /** Id fact da thay the fact nay (khi status = superseded). */
  supersededBy?: string;
  /** Id fact giu (keeper) khi fact nay bi gop (status = merged). */
  mergedInto?: string;
  /** Id cac fact da gop vao fact nay. */
  mergedFrom: string[];
  /** Nguon goc goc (chat/tool/import/dream/pattern). */
  origin: V22FactOrigin;
  /** Version tang dan, bat dau tu 1. */
  version: number;
}

/** Input tao fact moi (store tu sinh id + version + timestamp). */
export interface V22DreamFactInput {
  kind?: V22FactKind;
  text: string;
  topic?: string;
  value?: string;
  confidence?: number;
  sources?: string[];
  tags?: string[];
  sessionIds?: string[];
  observedAt?: number;
  validFrom?: number;
  validUntil?: number;
  origin?: V22FactOrigin;
}

/** Kich hoat chay dream. */
export type V22DreamTrigger =
  | 'scheduled'
  | 'steps'
  | 'compaction'
  | 'manual'
  | 'memory_pressure';

export const V22_DREAM_TRIGGERS: readonly V22DreamTrigger[] = [
  'scheduled',
  'steps',
  'compaction',
  'manual',
  'memory_pressure',
];

/** Trang thai cua mot dream job. */
export type V22DreamJobStatus = 'idle' | 'running' | 'done' | 'failed';

/** Mot phase trong pipeline dream. */
export type V22DreamPhase =
  | 'snapshot'
  | 'collect'
  | 'dedupe'
  | 'supersede'
  | 'expire'
  | 'patterns'
  | 'wiki'
  | 'budget'
  | 'report';

export const V22_DREAM_PHASES: readonly V22DreamPhase[] = [
  'snapshot',
  'collect',
  'dedupe',
  'supersede',
  'expire',
  'patterns',
  'wiki',
  'budget',
  'report',
];

/** Loai thay doi trong mot dream (co bang chung kem theo). */
export type V22DreamChangeKind =
  | 'merge'
  | 'supersede'
  | 'expire'
  | 'pattern'
  | 'promote'
  | 'budget_trim'
  | 'wiki'
  | 'restore';

/** Mot thay doi co bang chung: fact nao (truoc/sau) va vi sao. */
export interface V22DreamChange {
  /** Id thay doi duy nhat trong job (vd `chg-1`). */
  id: string;
  kind: V22DreamChangeKind;
  /** Id fact truoc thay doi (rong khi tao moi). */
  factIdsBefore: string[];
  /** Id fact sau thay doi. */
  factIdsAfter: string[];
  /** Ly do doc duoc (de hien UI / log). */
  reason: string;
  /** Chi tiet them (vd do tuong dong Jaccard, chenh confidence). */
  detail?: string;
  /** Epoch ms thuc hien thay doi. */
  at: number;
}

/** Do luong lop always-loaded (truoc/sau dream). */
export interface V22AlwaysLoadedMeasurement {
  /** Tong ky tu cua lop always-loaded. */
  chars: number;
  /** Token uoc tinh (chars/4 mac dinh, hoac ham dem host dua). */
  estimatedTokens: number;
  /** So fact trong lop always-loaded. */
  factCount: number;
  /** Ngan sach ky tu cho phep. */
  budgetChars: number;
  /** true = vua ngan sach. */
  withinBudget: boolean;
  /** So ky tu vuot ngan sach (0 khi vua). */
  overByChars: number;
  /** Id fact duoc chon vao lop always-loaded. */
  includedIds: string[];
  /** Id fact bi cat khoi lop always-loaded (kem ly do o plan). */
  excludedIds: string[];
}

/** Ke hoach always-loaded: fact nao vao, fact nao bi cat va vi sao. */
export interface V22AlwaysLoadedPlan {
  at: number;
  budgetChars: number;
  measurement: V22AlwaysLoadedMeasurement;
  /** Ly do cat cho tung fact bi loai (factId -> ly do). */
  excludedReasons: Record<string, string>;
  /** Diem uu tien cua tung fact duoc chon (factId -> diem). */
  scores: Record<string, number>;
  /** Text ghep san de dua vao prompt (cac dong `- text`). */
  renderedText: string;
}

/** Mot trang wiki: nhom fact cung chu de + link sang trang khac. */
export interface V22WikiPage {
  /** Slug duy nhat (vd `user-thich-uong`). */
  slug: string;
  /** Tieu de hien thi. */
  title: string;
  /** Chu de goc (topic) — 'general' khi fact khong co topic. */
  topic: string;
  /** Tom tat mot dong (tu fact manh nhat trong trang). */
  summary: string;
  /** Id fact thuoc trang (sap theo confidence giam dan). */
  factIds: string[];
  /** Link sang trang khac (ly do: tag chung / topic lien quan). */
  links: V22WikiLink[];
  /** Markdown day du cua trang (render san). */
  markdown: string;
  /** Epoch ms tao/cap nhat trang. */
  updatedAt: number;
}

/** Link giua hai trang wiki. */
export interface V22WikiLink {
  /** Slug trang dich. */
  slug: string;
  /** Ly do link (vd `tag chung: ca-phe`). */
  reason: string;
}

/** Chi muc wiki: toan bo trang sau mot dream. */
export interface V22WikiIndex {
  pages: V22WikiPage[];
  generatedAt: number;
  jobId: string;
  /** So trang them moi so voi lan truoc (0 o lan dau). */
  pagesAdded: number;
  /** So trang bien mat so voi lan truoc. */
  pagesRemoved: number;
  /** So trang doi noi dung (factIds thay doi). */
  pagesChanged: number;
}

/** Snapshot toan bo trang thai truoc dream (de rollback). */
export interface V22Snapshot {
  /** Id duy nhat (vd `snap-1794000000000-1`). */
  id: string;
  createdAt: number;
  /** Ai tao snapshot (`dream:job-...` / `user` / `system`). */
  actor: string;
  /** Ly do (vd `truoc dream job-...`). */
  reason: string;
  /** Ban sao sau (deep copy) toan bo fact luc chup. */
  facts: V22DreamFact[];
  /** Chi muc wiki luc chup (undefined neu chua co wiki). */
  wiki?: V22WikiIndex;
  /** Hash toan ven (FNV-1a hex tren JSON facts + wiki). */
  hash: string;
  /** Nhan tu do (vd `truoc-dream`, `thu-cong`). */
  label?: string;
}

/** Mot muc trong audit log append-only. */
export interface V22AuditEntry {
  /** Id duy nhat (vd `audit-1`). */
  id: string;
  /** Epoch ms. */
  at: number;
  /** Ai thuc hien. */
  actor: string;
  /** Hanh dong (vd `dream`, `rollback`, `merge`, `expire`). */
  action: string;
  /** Id fact lien quan. */
  factIds: string[];
  /** Id snapshot lien quan (neu co). */
  snapshotId?: string;
  /** Mo ta doc duoc. */
  detail: string;
}

/** Bao cao day du cua mot dream — bang chung cho moi thay doi. */
export interface V22DreamReport {
  jobId: string;
  trigger: V22DreamTrigger;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** true = chi mo phong, khong ghi thay doi nao. */
  dryRun: boolean;
  /** Id snapshot chup truoc dream (undefined khi dryRun). */
  snapshotId?: string;
  /** true = dream gap loi va da rollback ve snapshot. */
  rolledBack: boolean;
  /** So fact luc bat dau / ket thuc (active). */
  factsBefore: number;
  factsAfter: number;
  /** So ung vien fact thu thap tu transcript o phase collect. */
  factsCollected: number;
  duplicatesMerged: number;
  factsSuperseded: number;
  factsExpired: number;
  patternsCreated: number;
  patternsUpdated: number;
  wikiPages: number;
  /** Do luong always-loaded truoc / sau dream. */
  budgetBefore: V22AlwaysLoadedMeasurement;
  budgetAfter: V22AlwaysLoadedMeasurement;
  /** Moi thay doi deu co bang chung (fact truoc/sau + ly do). */
  changes: V22DreamChange[];
  /** Loi theo phase (rong = khong loi). */
  errors: string[];
  /** Muc bi bo qua co ly do (vd nhom can xem lai). */
  skipped: string[];
}

/** Trang thai job hien tai (de UI hien thi + scheduler quyet dinh). */
export interface V22DreamJobState {
  status: V22DreamJobStatus;
  /** So buoc hoi thoai ke tu lan dream cuoi. */
  stepsSinceRun: number;
  /** Epoch ms lan dream cuoi chay xong (undefined = chua chay). */
  lastRunAt?: number;
  /** Trigger cua lan dream cuoi. */
  lastTrigger?: V22DreamTrigger;
  /** Epoch ms du kien lan dream tiep theo (theo lich). */
  nextDueAt?: number;
  /** Bao cao cua lan dream cuoi (neu co). */
  lastReport?: V22DreamReport;
  /** Loi cua lan chay cuoi (neu that bai). */
  lastError?: string;
}

/** Cau hinh dreaming (scheduler + cac nguong). */
export interface V22DreamConfig {
  /** Tat = scheduler khong bao gio tu chay (chi chay tay). */
  enabled: boolean;
  /** Khoang cach giua hai lan chay theo lich (ms). */
  intervalMs: number;
  /** So buoc hoi thoai toi da truoc khi dream vi du buoc. */
  stepsThreshold: number;
  /** true = dream khi compaction chay. */
  runOnCompaction: boolean;
  /** Ngan sach ky tu toi da cho lop always-loaded. */
  maxCharsAlwaysLoaded: number;
  /** Nguong Jaccard de coi hai fact la trung lap. */
  dedupeThreshold: number;
  /** Chenh confidence toi thieu de chap nhan supersede. */
  minConfidenceGap: number;
  /** So session toi thieu de tong hop pattern. */
  patternMinSessions: number;
  /** So lan quan sat toi thieu de tong hop pattern. */
  patternMinObservations: number;
  /** Confidence toi thieu de fact duoc xet vao always-loaded. */
  promoteThreshold: number;
  /** So fact toi da xu ly trong mot dream (chong qua tai). */
  maxFactsPerDream: number;
  /** Half-life (ngay) cho diem uu tien always-loaded. */
  priorityHalfLifeDays: number;
  /** Nguong ap luc bo nho (0..1) de kich hoat dream vi memory_pressure. */
  memoryPressureThreshold: number;
  /** Actor ghi audit mac dinh. */
  actor: string;
}

/** Cau hinh mac dinh — that, dung duoc ngay, host co the doi. */
export const V22_DREAM_DEFAULT_CONFIG: V22DreamConfig = {
  enabled: true,
  intervalMs: 6 * 60 * 60 * 1000,
  stepsThreshold: 50,
  runOnCompaction: true,
  maxCharsAlwaysLoaded: 4000,
  dedupeThreshold: 0.6,
  minConfidenceGap: 0.1,
  patternMinSessions: 2,
  patternMinObservations: 3,
  promoteThreshold: 0.5,
  maxFactsPerDream: 500,
  priorityHalfLifeDays: 30,
  memoryPressureThreshold: 0.85,
  actor: 'dream:v22',
};

/** Gioi han cung (validation). */
export const V22_MAX_FACT_TEXT_CHARS = 2000;
export const V22_MIN_FACT_TEXT_CHARS = 3;
export const V22_MAX_FACTS_PER_STORE = 10000;
export const V22_MAX_TAGS_PER_FACT = 20;
export const V22_MAX_SOURCES_PER_FACT = 20;
export const V22_MAX_SESSIONS_PER_FACT = 500;
export const V22_MAX_SNAPSHOTS = 50;
export const V22_MAX_AUDIT_ENTRIES = 2000;
/** So ky tu uoc tinh cho 1 token (heuristic, ghi ro la uoc tinh). */
export const V22_CHARS_PER_TOKEN = 4;
/** Nhan block v20 dung de dong bo lop always-loaded (tuy chon). */
export const V22_ALWAYS_LOADED_BLOCK_LABEL = 'dreaming';
/** Confidence toi da sau khi boost pattern. */
export const V22_MAX_PATTERN_CONFIDENCE = 0.95;

/** Ket qua tra ve chung (khong throw o tang store). */
export interface V22Result<T> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

export type V22ErrorCode =
  | 'invalid_text'
  | 'invalid_confidence'
  | 'invalid_topic'
  | 'invalid_value'
  | 'fact_not_found'
  | 'store_full'
  | 'snapshot_not_found'
  | 'snapshot_corrupt'
  | 'invalid_config'
  | 'dream_disabled'
  | 'dream_running'
  | 'invalid_input';
