/**
 * Workspace abstraction v3 (v1.03, Đội T4) — public surface của
 * `packages/core/src/workspace/`.
 *
 * - types.ts: WorkspaceBackendKind/Quota/Meta/ExecResult/SnapshotMeta.
 * - quota.ts: ngân sách host (kế thừa compute/planner headroom) +
 *   ledger cấp phát + cửa sổ sử dụng.
 * - paths.ts: path safety (realpath symlink check).
 * - hardening.ts: guard exec (mẫu nguy hiểm + exec đồng thời +
 *   sandbox enforcer) — kế thừa sandbox/enforce.ts.
 * - local.ts: backend local (BotBoxManager).
 * - container.ts: backend container (docker/podman; fallback local
 *   trung thực khi không có runtime).
 * - snapshot.ts: snapshot/restore (manifest sha256 + rollback).
 * - workspace.ts: Workspace (handle agent cầm) + WorkspaceManager.
 * Xem README.md trong thư mục này.
 */
export { ContainerWorkspaceBackend, containerNameForWorkspace, defaultContainerRunner, detectContainerRuntime } from './container';
export type { ContainerRunResult, ContainerRunner, ContainerRuntime, ContainerWorkspaceBackendOptions } from './container';
export { WorkspaceExecGuard, findDangerousCommand, WORKSPACE_DANGEROUS_COMMAND_PATTERNS } from './hardening';
export type { WorkspaceExecGuardOptions } from './hardening';
export { LocalWorkspaceBackend, boxIdForWorkspace } from './local';
export type { LocalWorkspaceBackendOptions } from './local';
export { WorkspacePathError, isPathInsideRoot, resolveWithinRoot, toRelPath } from './paths';
export {
  DEFAULT_QUOTA_WINDOW_MS,
  DEFAULT_WORKSPACE_QUOTA,
  MB,
  WORKSPACE_QUOTA_FLOOR,
  WorkspaceQuotaLedger,
  WorkspaceUsageWindow,
  defaultHostBudget,
  freshWorkspaceUsage,
  hostBudgetFromProfile,
  resolveWorkspaceQuota,
  validateWorkspaceQuota,
} from './quota';
export { DEFAULT_MAX_SNAPSHOTS_PER_WORKSPACE, SNAPSHOTS_REL_DIR, WorkspaceSnapshotStore } from './snapshot';
export { DEFAULT_WORKSPACE_MAX_SNAPSHOTS, Workspace, WorkspaceManager, WORKSPACE_ID_RE, WORKSPACE_META_FILE, createWorkspaceBackend, validateWorkspaceId } from './workspace';
export type { WorkspaceManagerOptions } from './workspace';
export type {
  CreateWorkspaceOptions,
  ResolvedWorkspaceQuota,
  WorkspaceBackend,
  WorkspaceBackendKind,
  WorkspaceEntry,
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceHostBudget,
  WorkspaceMeta,
  WorkspaceQuota,
  WorkspaceSnapshotManifestEntry,
  WorkspaceSnapshotMeta,
  WorkspaceStatus,
  WorkspaceStatusView,
  WorkspaceUsage,
} from './types';
