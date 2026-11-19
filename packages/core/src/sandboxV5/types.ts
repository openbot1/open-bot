/**
 * Sandbox v5 — shared types (v1.37, Team T3).
 *
 * One layer above sandbox v4: v4 gives a per-conversation runtime
 * (v3 session + agent profile + budget meter + secret requests +
 * dependency map). V5 manages the runtime *fleet* for every bot:
 *
 *  - per-bot runtime choice (`runtimeTiers.ts`, `runtimeChoice.ts`)
 *    — every bot picks its own isolation tier (local / bwrap /
 *    syscall-policy / microvm / vm) plus a profile. The choice is
 *    stored per bot and survives restarts. Switching tiers while a
 *    bot is running is only safe through the switch procedure
 *    (`runtimeSwitch.ts`): quiesce, snapshot state, stop, start
 *    under the new tier, restore, verify — with rollback when any
 *    step fails, so a bot is never left half-migrated.
 *  - idle runtime archiving (`archive.ts`) — a runtime idle past
 *    its threshold is archived, not deleted: its workspace is
 *    packed (tar.gz when `tar` exists, plain copy otherwise) next
 *    to a metadata file that carries NO secret, and the live
 *    runtime is removed. An archive can be restored into a fresh
 *    runtime later.
 *  - disk budgets (`diskBudget.ts`) — the sandbox tree has a disk
 *    budget with a safety headroom. When usage passes the budget,
 *    caches are reclaimed oldest / least-used first, and
 *    gitignored directories (node_modules, dist, build, .cache…)
 *    are shed — never user files, never anything outside the
 *    sandbox roots. Every deletion is logged.
 *  - profile-scoped secrets (`profileSecrets.ts`) — a secret is
 *    granted to exactly one (bot, run, profile) triple, with a
 *    TTL and a use budget. The value lives in memory only and is
 *    NEVER written to disk, to a log, or into a report. When the
 *    run ends the grant is revoked; every grant / consume /
 *    revoke / expiry is written to a hash-chained audit log that
 *    carries metadata only.
 *
 * Ideas only from the survey in docs/repo-survey-v137.md
 * (per-tool-call timers, CIDR sandbox rules, router-local
 * sandbox tiers in recent CLI releases) — no code, text or
 * asset copied from any repo, xAI or Cursor.
 *
 * Fail-closed everywhere: an unknown bot, an unknown tier, a
 * switch on a running bot without drain, an archive restore
 * with a tampered manifest, a reclaim that would eat the
 * headroom, or a secret grant for a finished run all stop the
 * operation, never let it through silently.
 */

/** A bot id is a safe path segment: letters, digits, `_`, `-`, `.`. */
export const SANDBOX_V5_BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A run id is a safe slug: letters, digits, `_`, `-`. */
export const SANDBOX_V5_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A profile id is a safe slug: lowercase letters, digits, `_`, `-`. */
export const SANDBOX_V5_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A secret name: upper-case env-style name, letters/digits/`_`. */
export const SANDBOX_V5_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/** An archive id is a safe slug. */
export const SANDBOX_V5_ARCHIVE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Validate a bot id; returns the problem or '' when valid. */
export function sandboxV5BotIdProblem(botId: string): string {
  if (!SANDBOX_V5_BOT_ID_PATTERN.test(botId)) {
    return `Invalid botId "${botId}": use letters, digits, ".", "-" and "_" only, starting with a letter or digit.`;
  }
  if (botId.includes('..')) return `Invalid botId "${botId}": ".." is not allowed.`;
  return '';
}

/** Validate a run id; returns the problem or '' when valid. */
export function sandboxV5RunIdProblem(runId: string): string {
  if (!SANDBOX_V5_RUN_ID_PATTERN.test(runId)) {
    return `Invalid runId "${runId}": use letters, digits, "_" and "-" only.`;
  }
  return '';
}

/** Validate a profile id; returns the problem or '' when valid. */
export function sandboxV5ProfileIdProblem(profileId: string): string {
  if (!SANDBOX_V5_PROFILE_ID_PATTERN.test(profileId)) {
    return `Invalid profileId "${profileId}": use lowercase letters, digits, "_" and "-" only.`;
  }
  return '';
}

/** Validate a secret name; returns the problem or '' when valid. */
export function sandboxV5SecretNameProblem(name: string): string {
  if (!SANDBOX_V5_SECRET_NAME_PATTERN.test(name)) {
    return `Invalid secret name "${name}": use UPPER_CASE letters, digits and "_" only.`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Runtime tiers + per-bot choice
// ---------------------------------------------------------------------------

/** Isolation tiers a bot runtime can run on. Ordered weakest → strongest. */
export type SandboxV5Tier = 'local' | 'bwrap' | 'syscall-policy' | 'microvm' | 'vm';

/** All tiers, weakest first. */
export const SANDBOX_V5_TIERS: readonly SandboxV5Tier[] = [
  'local',
  'bwrap',
  'syscall-policy',
  'microvm',
  'vm',
];

/** Trust levels (same vocabulary as sandbox v2/v4). */
export type SandboxV5TrustLevel = 'trusted' | 'standard' | 'untrusted' | 'hostile';

/** What one tier guarantees, and what it costs. */
export interface SandboxV5TierInfo {
  /** Tier id. */
  tier: SandboxV5Tier;
  /** One-line display name. */
  name: string;
  /** What the tier isolates (shown in UI / reports). */
  description: string;
  /** True when the tier really isolates the process (not just a dir). */
  isolatesProcess: boolean;
  /** True when the tier confines the filesystem (bind mounts / VM disk). */
  confinesFilesystem: boolean;
  /** True when the tier confines the network (egress gate / VM net). */
  confinesNetwork: boolean;
  /** True when the tier enforces a syscall allowlist. */
  syscallPolicy: boolean;
  /** Relative startup cost: 1 = instant, higher = slower to start. */
  startupCost: 1 | 2 | 3 | 4 | 5;
  /** Relative runtime overhead: 1 = none, higher = slower. */
  overhead: 1 | 2 | 3 | 4 | 5;
  /** Platforms the tier can run on. */
  platforms: Array<'linux' | 'darwin' | 'win32'>;
  /** Minimum trust level this tier is safe for (weaker tiers need more trust). */
  minTrust: SandboxV5TrustLevel;
  /** Host binary / capability the tier needs ('' = none). */
  requires: string;
}

/** Lifecycle of a per-bot v5 runtime. */
export type SandboxV5RuntimeState =
  | 'created'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'archived'
  | 'destroyed';

/** One bot's runtime choice: which tier it runs on, and under which profile. */
export interface SandboxV5RuntimeChoice {
  /** Bot this choice belongs to. */
  botId: string;
  /** Chosen isolation tier. */
  tier: SandboxV5Tier;
  /** Agent profile id the bot runs under ('' = none assigned). */
  profileId: string;
  /** Trust level the choice was made for. */
  trust: SandboxV5TrustLevel;
  /** Resource limits applied to runs under this choice (bytes / ms). */
  limits: SandboxV5ChoiceLimits;
  /** When the choice was recorded (ms since epoch). */
  setAtMs: number;
  /** Who set it (user id, agent id, or `system`). Never a secret. */
  setBy: string;
  /** Why it was set (free text, shown in the audit trail). */
  reason: string;
  /** Choice version (bumped on every change). */
  version: number;
}

/** Resource limits that ride along with a runtime choice. */
export interface SandboxV5ChoiceLimits {
  /** Max write bytes per run (0 = use the box default). */
  maxWriteBytes: number;
  /** Timeout per run in ms (0 = use the box default). */
  timeoutMs: number;
  /** Max memory bytes per run (0 = no extra limit). */
  maxMemoryBytes: number;
  /** Max CPU seconds per run (0 = no extra limit). */
  cpuSeconds: number;
}

/** Defaults for choice limits (0 = inherit the box default). */
export function defaultSandboxV5ChoiceLimits(): SandboxV5ChoiceLimits {
  return { maxWriteBytes: 0, timeoutMs: 0, maxMemoryBytes: 0, cpuSeconds: 0 };
}

/** A per-bot runtime tracked by the v5 service (in-memory + persisted). */
export interface SandboxV5BotRuntime {
  /** Runtime id (uuid). */
  id: string;
  /** Bot this runtime belongs to. */
  botId: string;
  /** Current tier (mirrors the bot's choice at start time). */
  tier: SandboxV5Tier;
  /** Agent profile id ('' = none). */
  profileId: string;
  /** Current lifecycle state. */
  state: SandboxV5RuntimeState;
  /** Workspace directory for this bot runtime. */
  workdir: string;
  /** When the runtime was created (ms since epoch). */
  createdAtMs: number;
  /** Last activity — heartbeat / step / tool call (ms since epoch). */
  lastActivityAtMs: number;
  /** When the runtime ended (ms since epoch, 0 while live). */
  endedAtMs: number;
  /** Why the runtime ended (present once stopped / archived / destroyed). */
  endReason?: string;
  /** Number of tier switches this runtime has survived. */
  switchCount: number;
  /** Number of runs executed inside this runtime. */
  runCount: number;
}

/** Summary of a bot runtime for lists / reports. */
export interface SandboxV5BotRuntimeSummary {
  id: string;
  botId: string;
  tier: SandboxV5Tier;
  profileId: string;
  state: SandboxV5RuntimeState;
  workdir: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  idleMs: number;
  endedAtMs: number;
  endReason?: string;
  switchCount: number;
  runCount: number;
}

// ---------------------------------------------------------------------------
// Safe tier switch
// ---------------------------------------------------------------------------

/** Steps of a safe tier switch, in order. */
export type SandboxV5SwitchStep =
  | 'validate'
  | 'quiesce'
  | 'snapshot-state'
  | 'stop-old'
  | 'start-new'
  | 'restore-state'
  | 'verify'
  | 'rollback'
  | 'done';

/** Outcome of one switch step (recorded in the journal). */
export interface SandboxV5SwitchStepResult {
  step: SandboxV5SwitchStep;
  /** True when the step completed. */
  ok: boolean;
  /** ms the step took. */
  durationMs: number;
  /** Detail / failure reason (never a secret). */
  detail: string;
}

/** A tier-switch plan (dry-run): what would happen, before it happens. */
export interface SandboxV5SwitchPlan {
  botId: string;
  fromTier: SandboxV5Tier;
  toTier: SandboxV5Tier;
  /** Current runtime state when the plan was made. */
  runtimeState: SandboxV5RuntimeState;
  /** True when the switch can proceed (with drain if needed). */
  allowed: boolean;
  /** True when the runtime must be drained first (it is running). */
  needsDrain: boolean;
  /** Steps the switch would run, in order. */
  steps: SandboxV5SwitchStep[];
  /** Warnings (e.g. downgrading isolation, losing the syscall policy). */
  warnings: string[];
  /** Blockers (empty when allowed). */
  blockers: string[];
}

/** Result of a completed (or rolled-back) tier switch. */
export interface SandboxV5SwitchResult {
  botId: string;
  fromTier: SandboxV5Tier;
  toTier: SandboxV5Tier;
  /** True when the bot now runs on the new tier. */
  switched: boolean;
  /** True when the switch failed and the old tier was restored. */
  rolledBack: boolean;
  /** Step results, in execution order. */
  steps: SandboxV5SwitchStepResult[];
  /** Journal id (stable across retries of the same switch). */
  journalId: string;
  /** Total wall time in ms. */
  durationMs: number;
  /** Human-readable outcome (never a secret). */
  detail: string;
}

/** One journal entry for a tier switch (append-only, metadata only). */
export interface SandboxV5SwitchJournalEntry {
  /** Journal id (one per switch attempt). */
  journalId: string;
  /** Sequence number inside the journal (starts at 1). */
  seq: number;
  /** When the entry was written (ms since epoch). */
  atMs: number;
  /** Bot being switched. */
  botId: string;
  /** Step this entry records. */
  step: SandboxV5SwitchStep;
  /** What happened. */
  event: 'started' | 'completed' | 'failed' | 'rolled-back';
  /** Detail (never a secret). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Idle archiving
// ---------------------------------------------------------------------------

/** How an archive stores its workspace. */
export type SandboxV5ArchiveFormat = 'tar-gz' | 'copy';

/** Archive lifecycle states. */
export type SandboxV5ArchiveState = 'active' | 'restored' | 'deleted';

/** Metadata of one archived runtime (written to `meta.json` — NO secrets). */
export interface SandboxV5Archive {
  /** Archive id (uuid). */
  id: string;
  /** Bot the runtime belonged to. */
  botId: string;
  /** Runtime id that was archived. */
  runtimeId: string;
  /** Tier the runtime ran on before archiving. */
  tier: SandboxV5Tier;
  /** Profile id ('' = none). */
  profileId: string;
  /** Workspace bytes at archive time. */
  workspaceBytes: number;
  /** Storage format. */
  format: SandboxV5ArchiveFormat;
  /** Archive payload path (relative to the archive base dir). */
  payloadPath: string;
  /** Current state. */
  state: SandboxV5ArchiveState;
  /** When the runtime was created (ms since epoch). */
  runtimeCreatedAtMs: number;
  /** Last activity before archiving (ms since epoch). */
  lastActivityAtMs: number;
  /** When the archive was created (ms since epoch). */
  archivedAtMs: number;
  /** Idle time at archive time in ms. */
  idleMsAtArchive: number;
  /** Idle threshold that triggered the archive (ms). */
  idleThresholdMs: number;
  /** sha-256 of the payload (tar.gz bytes or manifest) — tamper check on restore. */
  payloadSha256: string;
  /** Number of files archived. */
  fileCount: number;
  /** Who archived it (user id, agent id, or `system`). */
  archivedBy: string;
  /** Why it was archived. */
  reason: string;
  /** When it was restored (ms since epoch, 0 = never). */
  restoredAtMs: number;
  /** Runtime id created by the restore ('' = never restored). */
  restoredRuntimeId: string;
}

/** A runtime that is idle enough to archive (scan result). */
export interface SandboxV5IdleCandidate {
  botId: string;
  runtimeId: string;
  state: SandboxV5RuntimeState;
  idleMs: number;
  idleThresholdMs: number;
  workspaceBytes: number;
  /** True when the runtime may be archived now. */
  archivable: boolean;
  /** Why not archivable ('' when archivable). */
  reason: string;
}

/** Result of an archive operation. */
export interface SandboxV5ArchiveResult {
  archive: SandboxV5Archive;
  /** True when the live runtime directory was removed. */
  liveRemoved: boolean;
}

/** Result of a restore operation. */
export interface SandboxV5RestoreResult {
  archiveId: string;
  /** New runtime id created by the restore. */
  runtimeId: string;
  botId: string;
  tier: SandboxV5Tier;
  workdir: string;
  /** True when the payload hash matched the manifest. */
  hashVerified: boolean;
  restoredFiles: number;
}

// ---------------------------------------------------------------------------
// Disk budget, cache reclaim, gitignored shed
// ---------------------------------------------------------------------------

/** How cache entries are picked for reclaim. */
export type SandboxV5ReclaimPolicy = 'oldest-first' | 'least-used-first' | 'largest-first';

/** A cache root the reclaimer may clean (never outside the sandbox base). */
export interface SandboxV5CacheRoot {
  /** Absolute path of the cache directory. */
  path: string;
  /** Kind label (e.g. `npm-cache`, `build-cache`, `download-cache`). */
  kind: string;
  /** Reclaim policy for this root. */
  policy: SandboxV5ReclaimPolicy;
}

/** Disk budget policy for one sandbox base directory. */
export interface SandboxV5DiskBudget {
  /** Total budget for the whole sandbox tree in bytes. */
  totalBudgetBytes: number;
  /** Bytes that must always stay free under the budget (safety headroom). */
  headroomBytes: number;
  /** Cache roots the reclaimer may clean. */
  cacheRoots: SandboxV5CacheRoot[];
  /** Workspace roots scanned for gitignored dirs to shed. */
  workspaceRoots: string[];
  /** Default idle threshold for archiving (ms). */
  idleThresholdMs: number;
}

/** Defaults: 2 GiB budget, 256 MiB headroom, 24 h idle threshold. */
export function defaultSandboxV5DiskBudget(): SandboxV5DiskBudget {
  return {
    totalBudgetBytes: 2 * 1024 ** 3,
    headroomBytes: 256 * 1024 ** 2,
    cacheRoots: [],
    workspaceRoots: [],
    idleThresholdMs: 24 * 60 * 60 * 1000,
  };
}

/** One cache entry (a file or directory under a cache root). */
export interface SandboxV5CacheEntry {
  /** Absolute path. */
  path: string;
  /** Which cache root it belongs to (kind label). */
  kind: string;
  /** True when the entry is a directory. */
  isDirectory: boolean;
  /** Size in bytes (recursive for directories). */
  sizeBytes: number;
  /** Last-modified time (ms since epoch). */
  mtimeMs: number;
  /** Last-access time (ms since epoch, 0 when unknown). */
  atimeMs: number;
  /** Age in ms (now - mtime). */
  ageMs: number;
}

/** Current disk usage of the sandbox tree. */
export interface SandboxV5DiskStatus {
  /** Base directory measured. */
  baseDir: string;
  /** Budget policy in force. */
  budget: SandboxV5DiskBudget;
  /** Total bytes used under the base dir. */
  usedBytes: number;
  /** Bytes used by cache roots. */
  cacheBytes: number;
  /** Bytes used by runtime workspaces. */
  workspaceBytes: number;
  /** Bytes used by archives. */
  archiveBytes: number;
  /** Bytes over (or under, when negative) the usable budget. */
  overBudgetBytes: number;
  /** True when usage is over the usable budget (budget - headroom). */
  overBudget: boolean;
  /** Bytes that may still be used before the usable budget is hit. */
  remainingBytes: number;
  /** When the status was measured (ms since epoch). */
  measuredAtMs: number;
}

/** One item a reclaim plan would remove. */
export interface SandboxV5ReclaimItem {
  /** Absolute path. */
  path: string;
  /** Why it is reclaimed: cache entry or gitignored dir. */
  kind: 'cache' | 'gitignored-dir';
  /** Cache kind label ('' for gitignored dirs). */
  cacheKind: string;
  /** Bytes this item would free. */
  sizeBytes: number;
  /** Age in ms. */
  ageMs: number;
  /** Reclaim reason (policy name + score detail). */
  reason: string;
}

/** A reclaim plan: dry-run first, execute only on approval. */
export interface SandboxV5ReclaimPlan {
  /** Budget the plan was made against. */
  budget: SandboxV5DiskBudget;
  /** Bytes that must be freed to get back under the usable budget. */
  needBytes: number;
  /** Items the plan would remove, in removal order. */
  items: SandboxV5ReclaimItem[];
  /** Bytes the plan would free. */
  wouldFreeBytes: number;
  /** True when the plan frees enough to get under budget. */
  enough: boolean;
  /** Bytes still over budget after the plan (0 when enough). */
  stillOverBytes: number;
  /** When the plan was made (ms since epoch). */
  plannedAtMs: number;
}

/** Result of executing a reclaim plan. */
export interface SandboxV5ReclaimResult {
  /** Items actually removed. */
  removed: SandboxV5ReclaimItem[];
  /** Items that could not be removed (path + reason). */
  failed: Array<{ path: string; reason: string }>;
  /** Bytes freed. */
  freedBytes: number;
  /** Bytes still over budget afterwards (0 = back under budget). */
  stillOverBytes: number;
  /** True when the tree is back under the usable budget. */
  backUnderBudget: boolean;
  /** When the reclaim ran (ms since epoch). */
  executedAtMs: number;
}

/** One reclaim log entry (append-only JSONL, metadata only). */
export interface SandboxV5ReclaimLogEntry {
  /** Sequence number (starts at 1). */
  seq: number;
  /** When the entry was written (ms since epoch). */
  atMs: number;
  /** What happened: planned / removed / failed / skipped. */
  event: 'planned' | 'removed' | 'failed' | 'skipped';
  /** Path involved. */
  path: string;
  /** Kind of item. */
  kind: 'cache' | 'gitignored-dir';
  /** Bytes freed (0 for planned / skipped). */
  freedBytes: number;
  /** Reason / detail (never a secret). */
  reason: string;
}

// ---------------------------------------------------------------------------
// Profile-scoped secrets
// ---------------------------------------------------------------------------

/** Grant lifecycle states. */
export type SandboxV5SecretGrantStatus = 'active' | 'consumed' | 'revoked' | 'expired';

/** A secret grant: metadata only — the VALUE is never stored here. */
export interface SandboxV5SecretGrant {
  /** Grant id (uuid). */
  id: string;
  /** Secret name (e.g. `GITHUB_TOKEN`). Never the value. */
  name: string;
  /** Bot the grant is scoped to. */
  botId: string;
  /** Run the grant is scoped to. */
  runId: string;
  /** Profile the grant is scoped to. */
  profileId: string;
  /** Current status. */
  status: SandboxV5SecretGrantStatus;
  /** Max number of consumes allowed (1 = single-use). */
  maxUses: number;
  /** Consumes used so far. */
  uses: number;
  /** When the grant was created (ms since epoch). */
  createdAtMs: number;
  /** When the grant expires (ms since epoch, 0 = never). */
  expiresAtMs: number;
  /** When the grant ended (ms since epoch, 0 while active). */
  endedAtMs: number;
  /** Who granted it (user id, agent id, or `system`). */
  grantedBy: string;
  /** Who revoked / ended it ('' while active). */
  endedBy: string;
  /** Why it was granted (shown to the auditor). */
  purpose: string;
  /** Why it ended ('' while active). */
  endReason: string;
}

/** Summary of a grant for lists (metadata only, never a value). */
export interface SandboxV5SecretGrantSummary {
  id: string;
  name: string;
  botId: string;
  runId: string;
  profileId: string;
  status: SandboxV5SecretGrantStatus;
  maxUses: number;
  uses: number;
  createdAtMs: number;
  expiresAtMs: number;
  endedAtMs: number;
  grantedBy: string;
  endedBy: string;
  purpose: string;
  endReason: string;
}

/** Result of consuming a grant (the value is returned ONLY here). */
export interface SandboxV5SecretConsumeResult {
  /** Grant id. */
  grantId: string;
  /** Secret name. */
  name: string;
  /** The secret value — the caller must not log or persist it. */
  value: string;
  /** Uses left after this consume (0 = grant is now consumed). */
  usesLeft: number;
  /** Grant status after this consume. */
  status: SandboxV5SecretGrantStatus;
}

/** One audit entry for a profile-scoped secret. Metadata only, hash-chained. */
export interface SandboxV5SecretAuditEntry {
  /** Sequence number inside the audit log (starts at 1). */
  seq: number;
  /** When the event happened (ms since epoch). */
  atMs: number;
  /** Grant the event belongs to. */
  grantId: string;
  /** Secret name (never the value). */
  name: string;
  /** Bot / run / profile scope. */
  botId: string;
  runId: string;
  profileId: string;
  /** What happened. */
  event: 'granted' | 'consumed' | 'revoked' | 'expired' | 'revoked-run-end';
  /** Who did it (user id, agent id, or `system`). Never a secret value. */
  actor: string;
  /** Short human-readable detail. Never a secret value. */
  detail: string;
  /** sha-256 chain hash over (prevHash + this entry without its own hash). */
  hash: string;
  /** Hash of the previous entry ('' for seq 1). */
  prevHash: string;
}

/** Result of revoking every grant of one run (run end). */
export interface SandboxV5RunRevokeResult {
  runId: string;
  botId: string;
  /** Grant ids revoked by this call. */
  revokedGrantIds: string[];
  /** Grants already ended before this call (left alone). */
  alreadyEndedGrantIds: string[];
  /** When the revoke ran (ms since epoch). */
  revokedAtMs: number;
}
