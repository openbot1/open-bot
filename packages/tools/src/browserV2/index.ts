/**
 * Browser driver v2 — public exports (v1.33, Đội T4).
 *
 *  - `a11ySnapshot`: parse/serialize/diff accessibility-tree snapshot.
 *  - `snapshotCache`: cache theo step, chỉ gửi diff về model.
 *  - `egressGate`: allowlist chống page hijack (mỗi step).
 *  - `visionFallback`: click tọa độ khi element không có trong tree.
 *  - `driverV2`: session v2 nối vào driver v1 (Playwright thật/fake).
 *  - `playwrightMcpServer`: MCP server mode (stdio JSON-RPC).
 *  - `webVoyagerEval`: self-eval WebVoyager-local (fixture, spec-tagged).
 *  - `browserV2Tools`: 8 agent tool v2 (xem `browserV2Tools.ts`).
 */
export {
  parseAriaSnapshot,
  serializeAriaSnapshot,
  parseSnapshotLine,
  assignRefs,
  flattenSnapshot,
  findNodeByRef,
  countNodes,
  interactiveNodes,
  diffSnapshots,
  renderSnapshotDiff,
  estimateTokens,
  truncateSnapshot,
} from  './a11ySnapshot';
export type {
  A11yNode,
  A11yChecked,
  FlatA11yNode,
  SnapshotDiff,
  ParsedSnapshotLine,
} from  './a11ySnapshot';

export { SnapshotCache, createSnapshotCache } from  './snapshotCache';
export type {
  CachedSnapshot,
  SnapshotCacheStats,
  SnapshotCacheOptions,
  SnapshotPayload,
} from  './snapshotCache';

export {
  BrowserEgressGate,
  createEgressGate,
  hostMatchesPattern,
  normalizeHostPattern,
  isLocalhost,
  hostOf,
} from  './egressGate';
export type {
  EgressGateAction,
  EgressGateDecision,
  EgressBlockEntry,
  EgressGateOptions,
} from  './egressGate';

export { VisionFallback, createVisionFallback } from  './visionFallback';
export type {
  ViewportSize,
  CoordinateClicker,
  ElementBox,
  RegisteredVisualElement,
  CoordinateClickRecord,
  VisionFallbackOptions,
} from  './visionFallback';

export {
  BrowserV2Session,
  createBrowserV2Session,
  launchPlaywrightBrowserV2,
} from  './driverV2';
export type {
  BrowserV2PageDriver,
  BrowserDriverV2,
  BrowserV2Launcher,
  BrowserV2Options,
  BrowserV2StepRecord,
  BrowserV2SnapshotResult,
} from  './driverV2';

export {
  PlaywrightMcpServer,
  createPlaywrightMcpServer,
  PLAYWRIGHT_MCP_TOOLS,
  McpRpcError,
} from  './playwrightMcpServer';
export type {
  PlaywrightMcpToolDef,
  McpContentBlock,
  McpToolResult,
  PlaywrightMcpServerOptions,
} from  './playwrightMcpServer';

export {
  runWebVoyagerEval,
  renderWebVoyagerReport,
  evaluateCheck,
  createFixtureDriver,
  scriptedAgent,
  WEBVOYAGER_TASKS,
  WEBVOYAGER_FIXTURE_HOST,
  WEBVOYAGER_HARNESS_VERSION,
  WEBVOYAGER_DATASET,
} from  './webVoyagerEval';
export type {
  WebVoyagerCheck,
  WebVoyagerAction,
  WebVoyagerStepContext,
  WebVoyagerStepFn,
  WebVoyagerTask,
  WebVoyagerTaskResult,
  WebVoyagerEvalSpec,
  WebVoyagerEvalReport,
  WebVoyagerRunnerOptions,
  FixturePageDef,
  FixtureClickAction,
} from  './webVoyagerEval';

export {
  createBrowserV2Tools,
  createBrowserV2ToolsSession,
  BROWSER_V2_TOOLS,
} from '../browserV2Tools';
export type { BrowserV2ToolsOptions, BrowserV2ToolsSession } from '../browserV2Tools';
