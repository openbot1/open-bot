/**
 * Coding agent v18 tools (v1.40, Đội T4) — 8 tools.
 *
 * Nối coding agent v17 tools (v1.39): placeholder trong ALL_TOOLS cho
 * tới khi host bind (`createCodingV18Tools(getBaseDir)` với userData
 * dir). Không gọi model thật, không gọi mạng — mọi tool làm việc trên
 * file local trong thư mục dữ liệu v18:
 *
 *   <base>/coding-v18/
 *     critic-history.json  (lịch sử chấm critic, append-only)
 *     config.json          (ngưỡng critic + rule review bật/tắt)
 *     depmaps.json         (dependency map đã build, kèm fingerprint)
 *     evals.json           (eval comparison đã chạy)
 *
 *  - coding_v18_critic  — chấm trajectory/patch (5 trục, ngưỡng cấu
 *    hình được, chặn push khi điểm thấp), xem lịch sử chấm.
 *  - coding_v18_review  — review skill 16 rule trên patch/diff; PR
 *    review (gate merge + summary).
 *  - coding_v18_depmap  — build/query dependency map, topo order,
 *    phát hiện cycle.
 *  - coding_v18_zones   — vùng sở hữu (build/list/check xung đột
 *    trước khi sửa).
 *  - coding_v18_eval    — chạy 3 verifier (critic + review-skill +
 *    dependency-map) trên cùng task, so sánh kết quả.
 *  - coding_v18_verify  — verification stack v18 đầy đủ cho một
 *    phiên (critic + review + depmap + eval).
 *  - coding_v18_agent   — chạy phiên agent v18 scripted end-to-end.
 *  - coding_v18_config  — xem/đặt ngưỡng critic + rule review.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  V18_DEFAULT_CRITIC_CONFIG,
  V18_REVIEW_RULES,
  renderV18AgentReport,
  renderV18AutoFixResult,
  renderV18CriticHistory,
  renderV18CriticTrend,
  renderV18CriticVerdict,
  renderV18DepGraph,
  renderV18EvalComparison,
  renderV18EvalSuiteReport,
  renderV18GraphStats,
  renderV18ImpactSet,
  renderV18ReviewReport,
  renderV18TopoPlan,
  renderV18ZoneConflicts,
  renderV18Zones,
  runV18Agent,
  v18AppendCriticHistory,
  v18ApplyAutoFixes,
  v18BuildDepGraph,
  v18BuildZones,
  v18CheckZoneConflicts,
  v18CriticHistoryStats,
  v18CriticPreset,
  v18CriticTrend,
  v18DefaultZoneDefs,
  v18FindOrphans,
  v18ImpactSet,
  v18LoadCriticHistory,
  v18ReviewPatch,
  v18ReviewPr,
  v18RunEvalComparison,
  v18RunEvalSuite,
  v18SaveCriticHistory,
  v18ScorePatch,
  v18ScoreTrajectory,
  v18TopoOrder,
  v18ValidateCriticConfig,
} from '@open-bot/core';
import type {
  V18CriticConfig,
  V18DepGraph,
  V18EvalComparison,
  V18ReviewReport,
  V18TrajectoryStep,
  V18ZoneDef,
} from '@open-bot/core';

export const CODING_V18_TOOL_NAMES = [
  'coding_v18_critic',
  'coding_v18_review',
  'coding_v18_depmap',
  'coding_v18_zones',
  'coding_v18_eval',
  'coding_v18_verify',
  'coding_v18_agent',
  'coding_v18_config',
] as const;

export type CodingV18ToolName = (typeof CODING_V18_TOOL_NAMES)[number];

export function isCodingV18ToolName(name: string): boolean {
  return (CODING_V18_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV18ToolOptions {
  /** Thư mục workspace fallback (ưu tiên ctx.workspaceDir). */
  getWorkspaceDir?: () => string | null | undefined;
}

/** Thư mục dữ liệu v18 trong base dir của host. */
export function codingV18DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v18');
}

/** Tạo (nếu chưa có) thư mục dữ liệu v18, trả đường dẫn. */
export function codingV18EnsureDataDir(baseDir: string): string {
  const dir = codingV18DataDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function getStringArg(args: Record<string, unknown>, name: string, required = false): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getIntArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Argument "${name}" must be an integer, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

/** Parse một JSON string thành object (lỗi rõ ràng khi sai định dạng). */
function parseJsonObjectArg(raw: string, name: string): Record<string, unknown> {
  if (raw.trim() === '') throw new Error(`Argument "${name}" must be valid JSON object.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Argument "${name}" must be valid JSON object.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Argument "${name}" must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** Parse một JSON string thành map path -> nội dung file. */
function parseFilesArg(raw: string, name: string): Record<string, string> {
  const obj = parseJsonObjectArg(raw, name);
  for (const [filePath, content] of Object.entries(obj)) {
    if (typeof content !== 'string') {
      throw new Error(`Argument "${name}[${filePath}]" must be a string.`);
    }
  }
  return obj as Record<string, string>;
}

/** Đọc JSON file (trả fallback khi chưa có / lỗi parse). */
function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Ghi JSON file (tạo thư mục cha khi cần). */
function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** File critic-history.json / config.json / depmaps.json / evals.json trong data dir. */
function criticHistoryFile(dataDir: string): string {
  return path.join(dataDir, 'critic-history.json');
}
function configFile(dataDir: string): string {
  return path.join(dataDir, 'config.json');
}
function depMapsFile(dataDir: string): string {
  return path.join(dataDir, 'depmaps.json');
}
function evalsFile(dataDir: string): string {
  return path.join(dataDir, 'evals.json');
}

interface V18StoredConfig {
  critic?: V18CriticConfig;
  disabledReviewRules?: string[];
}

/** Load config đã lưu (mặc định khi chưa có). */
function loadStoredConfig(dataDir: string): V18StoredConfig {
  return readJsonFile<V18StoredConfig>(configFile(dataDir), {});
}

/** Load ngưỡng critic (ưu tiên config lưu, rồi config truyền vào, rồi mặc định). */
function resolveCriticConfig(dataDir: string, raw: string): V18CriticConfig {
  const stored = loadStoredConfig(dataDir);
  if (raw.trim() !== '') {
    const obj = parseJsonObjectArg(raw, 'criticConfigJson');
    return v18ValidateCriticConfig({
      approveScore: typeof obj['approveScore'] === 'number' ? obj['approveScore'] : V18_DEFAULT_CRITIC_CONFIG.approveScore,
      blockScore: typeof obj['blockScore'] === 'number' ? obj['blockScore'] : V18_DEFAULT_CRITIC_CONFIG.blockScore,
      weights: (obj['weights'] as V18CriticConfig['weights']) ?? undefined,
      disabledDimensions: (obj['disabledDimensions'] as V18CriticConfig['disabledDimensions']) ?? undefined,
    });
  }
  if (stored.critic) return v18ValidateCriticConfig(stored.critic);
  return V18_DEFAULT_CRITIC_CONFIG;
}

/** Load dependency map đã lưu theo root (undefined khi chưa có). */
function loadDepMap(dataDir: string, root: string): V18DepGraph | undefined {
  const store = readJsonFile<Record<string, V18DepGraph>>(depMapsFile(dataDir), {});
  return store[root];
}

/** Lưu dependency map (ghi đè theo root). */
function saveDepMap(dataDir: string, graph: V18DepGraph): void {
  const store = readJsonFile<Record<string, V18DepGraph>>(depMapsFile(dataDir), {});
  store[graph.root] = graph;
  writeJsonFile(depMapsFile(dataDir), store);
}

/** Lưu eval comparison (append theo task id, giữ 20 bản mới nhất). */
function saveEvalComparison(dataDir: string, comparison: V18EvalComparison): void {
  const store = readJsonFile<Record<string, V18EvalComparison[]>>(evalsFile(dataDir), {});
  const list = store[comparison.taskId] ?? [];
  list.push(comparison);
  store[comparison.taskId] = list.slice(-20);
  writeJsonFile(evalsFile(dataDir), store);
}

/** Parse trajectory steps từ JSON (validate kind/text cơ bản). */
function parseTrajectorySteps(raw: string): V18TrajectoryStep[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Argument "stepsJson" must be a JSON array.');
  return parsed.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') throw new Error(`stepsJson[${idx}] phải là object.`);
    const step = entry as Record<string, unknown>;
    if (typeof step['kind'] !== 'string') throw new Error(`stepsJson[${idx}].kind phải là string.`);
    const out: V18TrajectoryStep = { kind: step['kind'] as V18TrajectoryStep['kind'] };
    if (typeof step['text'] === 'string') out.text = step['text'];
    if (Array.isArray(step['files'])) out.files = step['files'] as string[];
    if (typeof step['exitCode'] === 'number') out.exitCode = step['exitCode'];
    if (typeof step['passed'] === 'boolean') out.passed = step['passed'];
    if (typeof step['durationMs'] === 'number') out.durationMs = step['durationMs'];
    return out;
  });
}

/** Parse zone defs từ JSON (mặc định khi rỗng). */
function parseZoneDefs(raw: string): V18ZoneDef[] {
  if (raw.trim() === '') return v18DefaultZoneDefs();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Argument "zonesJson" must be a JSON array.');
  return parsed.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') throw new Error(`zonesJson[${idx}] phải là object.`);
    const def = entry as Record<string, unknown>;
    if (typeof def['id'] !== 'string' || typeof def['name'] !== 'string' || typeof def['owner'] !== 'string') {
      throw new Error(`zonesJson[${idx}] cần id, name, owner là string.`);
    }
    if (!Array.isArray(def['prefixes'])) throw new Error(`zonesJson[${idx}].prefixes phải là array.`);
    return { id: def['id'], name: def['name'], owner: def['owner'], prefixes: def['prefixes'] as string[] };
  });
}

/** Dựng diff text đơn giản từ patchFiles (cho review khi caller không đưa diff). */
function buildDiffText(patchFiles: Record<string, string>): string {
  return Object.entries(patchFiles)
    .map(([file, content]) => `--- a/${file}\n+++ b/${file}\n${content.split('\n').map((l) => `+${l}`).join('\n')}`)
    .join('\n');
}

export function createCodingV18Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV18ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const resolveDataDir = (ctx: ToolContext): string => {
    const base = resolveBase();
    if (base) return codingV18EnsureDataDir(base);
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) {
      return codingV18EnsureDataDir(path.join(ctx.workspaceDir, '.open-bot'));
    }
    const fallback = toolOptions.getWorkspaceDir?.();
    if (typeof fallback === 'string' && fallback.trim().length > 0) {
      return codingV18EnsureDataDir(path.join(fallback, '.open-bot'));
    }
    return codingV18EnsureDataDir(path.join(os.tmpdir(), 'open-bot-coding-v18'));
  };

  const tools: Tool[] = [
    {
      definition: toolDef(
        'coding_v18_critic',
        'Score a coding v18 trajectory or patch with the deterministic critic (5 axes: completeness/efficiency/error-recovery/safety/test-coverage). Configurable approve/block thresholds; verdict=block BLOCKS the push. Also lists critic verdict history and quality trend.',
        {
          action: { type: 'string', description: 'Action: score-trajectory | score-patch | history | stats | trend.' },
          sessionId: { type: 'string', description: 'Session id (for score-trajectory / history).' },
          stepsJson: { type: 'string', description: 'JSON array of trajectory steps {kind, text?, files?, exitCode?, passed?} (for score-trajectory).' },
          patchJson: { type: 'string', description: 'JSON object path -> new file content (for score-patch).' },
          diffText: { type: 'string', description: 'Diff text for the patch (optional; built from patchJson when empty).' },
          plannedFilesJson: { type: 'string', description: 'JSON array of planned file paths (optional, for completeness scoring).' },
          criticConfigJson: { type: 'string', description: 'JSON critic config {approveScore, blockScore} (optional; stored config wins when empty).' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          if (action === 'history') {
            const history = v18LoadCriticHistory(criticHistoryFile(dataDir));
            return renderV18CriticHistory(history);
          }
          if (action === 'stats') {
            const history = v18LoadCriticHistory(criticHistoryFile(dataDir));
            const stats = v18CriticHistoryStats(history);
            return `Critic v18 stats: ${stats.total} lần chấm, điểm trung bình ${stats.averageScore} (thấp nhất ${stats.lowestScore}, cao nhất ${stats.highestScore}), approve ${stats.approved}, request-changes ${stats.requestChanges}, block ${stats.blocked}.`;
          }
          if (action === 'trend') {
            const history = v18LoadCriticHistory(criticHistoryFile(dataDir));
            return renderV18CriticTrend(v18CriticTrend(history));
          }
          const config = resolveCriticConfig(dataDir, getStringArg(args, 'criticConfigJson'));
          const plannedRaw = getStringArg(args, 'plannedFilesJson');
          const plannedFiles = plannedRaw.trim() === '' ? undefined : (JSON.parse(plannedRaw) as string[]);
          if (action === 'score-trajectory') {
            const sessionId = getStringArg(args, 'sessionId', true);
            const steps = parseTrajectorySteps(getStringArg(args, 'stepsJson', true));
            if (steps.length === 0) return errorResult('Trajectory rỗng — chưa có bước để chấm.');
            const verdict = v18ScoreTrajectory(sessionId, steps, {
              ...(plannedFiles ? { plannedFiles } : {}),
              config,
            });
            const history = v18AppendCriticHistory(v18LoadCriticHistory(criticHistoryFile(dataDir)), verdict, verdict.reasons[0] ?? verdict.verdict);
            v18SaveCriticHistory(criticHistoryFile(dataDir), history);
            return `${renderV18CriticVerdict(verdict)}\nĐã lưu vào lịch sử chấm (${history.length} entries).`;
          }
          if (action === 'score-patch') {
            const patch = parseFilesArg(getStringArg(args, 'patchJson', true), 'patchJson');
            const diffText = getStringArg(args, 'diffText') || buildDiffText(patch);
            const verdict = v18ScorePatch(patch, diffText, {
              ...(plannedFiles ? { plannedFiles } : {}),
              config,
            });
            const history = v18AppendCriticHistory(v18LoadCriticHistory(criticHistoryFile(dataDir)), verdict, verdict.reasons[0] ?? verdict.verdict);
            v18SaveCriticHistory(criticHistoryFile(dataDir), history);
            return `${renderV18CriticVerdict(verdict)}\nĐã lưu vào lịch sử chấm (${history.length} entries).`;
          }
          return errorResult(`Unknown action "${action}" (score-trajectory | score-patch | history | stats | trend).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v18_review',
        'Run the coding v18 automatic review skill on a patch/diff (16 rules: secrets, destructive commands, sensitive files, oversized patch, missing tests, long functions, console.log left, empty catch, any-cast, TODO without owner, duplicate imports, deep relative imports, missing EOF newline, circular imports, unhandled promises). PR review adds the merge gate + summary. Autofix applies the safe automatic fixes (EOF newline, remove console.log, merge duplicate imports) and reports what still needs a human.',
        {
          action: { type: 'string', description: 'Action: review | pr | autofix.' },
          patchJson: { type: 'string', description: 'JSON object path -> new file content (the change to review).' },
          diffText: { type: 'string', description: 'Diff text (optional; built from patchJson when empty).' },
          enabledRulesJson: { type: 'string', description: 'JSON array of rule ids to run (optional; all rules by default, stored disabled rules apply).' },
          maxWarnings: { type: 'integer', description: 'Max warnings allowed before the PR gate fails (for action=pr; default: only errors fail).' },
        },
        ['action', 'patchJson'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const patch = parseFilesArg(getStringArg(args, 'patchJson', true), 'patchJson');
          const diffText = getStringArg(args, 'diffText') || buildDiffText(patch);
          const dataDir = resolveDataDir(ctx);
          const stored = loadStoredConfig(dataDir);
          const disabledStored = new Set(stored.disabledReviewRules ?? []);
          const enabledRaw = getStringArg(args, 'enabledRulesJson');
          const enabledRules = enabledRaw.trim() === ''
            ? V18_REVIEW_RULES.map((r) => r.id).filter((id) => !disabledStored.has(id))
            : (JSON.parse(enabledRaw) as string[]);
          if (action === 'review') {
            const report: V18ReviewReport = v18ReviewPatch(patch, diffText, { enabledRules });
            return renderV18ReviewReport(report);
          }
          if (action === 'pr') {
            const maxWarnings = getIntArg(args, 'maxWarnings');
            const pr = v18ReviewPr(patch, diffText, {
              enabledRules,
              ...(maxWarnings !== undefined ? { maxWarnings } : {}),
            });
            return pr.summary;
          }
          if (action === 'autofix') {
            const report: V18ReviewReport = v18ReviewPatch(patch, diffText, { enabledRules });
            const fixed = v18ApplyAutoFixes(patch, report);
            const after = v18ReviewPatch(fixed.patch, buildDiffText(fixed.patch), { enabledRules });
            return [
              renderV18AutoFixResult(fixed),
              `Sau auto-fix: review ${after.verdict.toUpperCase()} (${after.errorCount} error / ${after.warningCount} warning / ${after.infoCount} info).`,
              `Patch đã sửa: ${JSON.stringify(fixed.patch)}`,
            ].join('\n');
          }
          return errorResult(`Unknown action "${action}" (review | pr | autofix).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v18_depmap',
        'Build/query a coding v18 dependency map for a whole repo (module imports module), compute the topo fix order (parallel waves), detect import cycles, and compute the impact set (blast radius) of changing files. Read-only after build.',
        {
          root: { type: 'string', description: 'Repo root label for the map (e.g. absolute path or repo name).' },
          action: { type: 'string', description: 'Action: build | query | topo | cycles | impact | orphans | stats.' },
          filesJson: { type: 'string', description: 'JSON object path -> file content (for build) or JSON array of changed file paths (for impact).' },
          query: { type: 'string', description: 'File path to inspect (for query: its imports + importers).' },
        },
        ['root', 'action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const root = getStringArg(args, 'root', true);
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          if (action === 'build') {
            const files = new Map(Object.entries(parseFilesArg(getStringArg(args, 'filesJson', true), 'filesJson')));
            const graph = v18BuildDepGraph(root, files);
            saveDepMap(dataDir, graph);
            return renderV18DepGraph(graph, 10);
          }
          const graph = loadDepMap(dataDir, root);
          if (!graph) return errorResult(`Chưa có dependency map cho "${root}" — chạy action=build trước.`);
          if (action === 'query') {
            const queryPath = getStringArg(args, 'query', true);
            const node = graph.nodes.find((n) => n.path === queryPath);
            if (!node) return errorResult(`File "${queryPath}" không có trong dependency map "${root}".`);
            return `File "${queryPath}" (${node.kind}, depth ${node.depth}):\n  import: ${node.imports.join(', ') || '(không có)'}\n  được import bởi: ${node.importedBy.join(', ') || '(không có)'}`;
          }
          if (action === 'topo') {
            return renderV18TopoPlan(v18TopoOrder(graph));
          }
          if (action === 'cycles') {
            if (graph.cycles.length === 0) return `Dependency map "${root}": không có cycle.`;
            return `Dependency map "${root}": ${graph.cycles.length} cycle:\n${graph.cycles.map((c) => `  ${c.join(' -> ')} -> ${c[0]}`).join('\n')}`;
          }
          if (action === 'impact') {
            const changed = JSON.parse(getStringArg(args, 'filesJson', true)) as string[];
            const impacted = v18ImpactSet(graph, changed);
            return `${renderV18ImpactSet(graph, changed)}\nTất cả file ảnh hưởng (${impacted.length}): ${impacted.join(', ') || '(không có)'}`;
          }
          if (action === 'orphans') {
            const orphans = v18FindOrphans(graph);
            if (orphans.length === 0) return `Dependency map "${root}": không có orphan (file chết).`;
            return `Dependency map "${root}": ${orphans.length} orphan (không bị import, không phải entry quen thuộc):\n${orphans.map((f) => `  ${f}`).join('\n')}`;
          }
          if (action === 'stats') {
            return renderV18GraphStats(graph);
          }
          return errorResult(`Unknown action "${action}" (build | query | topo | cycles | impact | orphans | stats).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v18_zones',
        'Ownership zones for a coding v18 dependency map: build/list zones by path prefix, and check zone conflicts BEFORE editing (cross-zone edit, out-of-order edit, file in an import cycle).',
        {
          root: { type: 'string', description: 'Repo root label of the built dependency map.' },
          action: { type: 'string', description: 'Action: build | list | check.' },
          zonesJson: { type: 'string', description: 'JSON array of zone defs {id, name, owner, prefixes[]} (optional; defaults to the repo layout).' },
          filesJson: { type: 'string', description: 'JSON array of files the agent plans to edit (for check).' },
          agentZone: { type: 'string', description: 'Zone id of the agent (for check: edits outside it conflict).' },
        },
        ['root', 'action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const root = getStringArg(args, 'root', true);
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          const graph = loadDepMap(dataDir, root);
          if (!graph) return errorResult(`Chưa có dependency map cho "${root}" — chạy coding_v18_depmap action=build trước.`);
          const zoneDefs = parseZoneDefs(getStringArg(args, 'zonesJson'));
          const plan = v18BuildZones(graph, zoneDefs);
          if (action === 'build' || action === 'list') {
            return renderV18Zones(plan);
          }
          if (action === 'check') {
            const files = JSON.parse(getStringArg(args, 'filesJson', true)) as string[];
            const agentZone = getStringArg(args, 'agentZone');
            const conflicts = v18CheckZoneConflicts(graph, plan.zones, files, {
              ...(agentZone ? { agentZone } : {}),
              topoPlan: v18TopoOrder(graph),
            });
            return renderV18ZoneConflicts(conflicts);
          }
          return errorResult(`Unknown action "${action}" (build | list | check).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v18_eval',
        'Run the coding v18 eval harness: 3 verifiers (critic + review-skill + dependency-map) on the SAME task, compare results and report pass/fail per verifier. Suite action runs the comparison on MANY tasks and aggregates per-verifier pass rates.',
        {
          action: { type: 'string', description: 'Action: compare (default) | suite.' },
          taskId: { type: 'string', description: 'Task id for the comparison (for compare).' },
          patchJson: { type: 'string', description: 'JSON object path -> new file content (the patch to verify, for compare).' },
          stepsJson: { type: 'string', description: 'JSON array of trajectory steps (optional; critic scores the patch when empty).' },
          diffText: { type: 'string', description: 'Diff text (optional; built from patchJson when empty).' },
          repoFilesJson: { type: 'string', description: 'JSON object path -> content for the whole repo (optional; dependency-map checker skips when empty).' },
          plannedFilesJson: { type: 'string', description: 'JSON array of planned file paths (optional).' },
          agentZone: { type: 'string', description: 'Zone id of the agent (optional; dependency-map checker verifies cross-zone edits).' },
          criticConfigJson: { type: 'string', description: 'JSON critic config {approveScore, blockScore} (optional).' },
          tasksJson: { type: 'string', description: 'JSON array of eval tasks {taskId, patchJson, stepsJson?, repoFilesJson?, plannedFilesJson?} (for suite).' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action') || 'compare';
          const dataDir = resolveDataDir(ctx);
          if (action === 'suite') {
            const tasksRaw = getStringArg(args, 'tasksJson', true);
            const tasksParsed: unknown = JSON.parse(tasksRaw);
            if (!Array.isArray(tasksParsed) || tasksParsed.length === 0) {
              return errorResult('Argument "tasksJson" must be a non-empty JSON array.');
            }
            const config = resolveCriticConfig(dataDir, getStringArg(args, 'criticConfigJson'));
            const inputs = tasksParsed.map((entry, idx) => {
              if (!entry || typeof entry !== 'object') throw new Error(`tasksJson[${idx}] phải là object.`);
              const task = entry as Record<string, unknown>;
              if (typeof task['taskId'] !== 'string') throw new Error(`tasksJson[${idx}].taskId phải là string.`);
              if (typeof task['patchJson'] !== 'string') throw new Error(`tasksJson[${idx}].patchJson phải là string.`);
              const patch = parseFilesArg(task['patchJson'], `tasksJson[${idx}].patchJson`);
              const stepsRaw = typeof task['stepsJson'] === 'string' ? task['stepsJson'] : '';
              const steps = stepsRaw.trim() === '' ? undefined : parseTrajectorySteps(stepsRaw);
              const repoRaw = typeof task['repoFilesJson'] === 'string' ? task['repoFilesJson'] : '';
              const repoFiles = repoRaw.trim() === ''
                ? undefined
                : new Map(Object.entries(parseFilesArg(repoRaw, `tasksJson[${idx}].repoFilesJson`)));
              const plannedRaw = typeof task['plannedFilesJson'] === 'string' ? task['plannedFilesJson'] : '';
              const plannedFiles = plannedRaw.trim() === '' ? undefined : (JSON.parse(plannedRaw) as string[]);
              return {
                taskId: task['taskId'],
                patch,
                criticConfig: config,
                ...(steps ? { steps } : {}),
                ...(repoFiles ? { repoFiles } : {}),
                ...(plannedFiles ? { plannedFiles } : {}),
              };
            });
            const suite = v18RunEvalSuite(inputs);
            for (const comparison of suite.comparisons) saveEvalComparison(dataDir, comparison);
            return renderV18EvalSuiteReport(suite);
          }
          if (action !== 'compare') return errorResult(`Unknown action "${action}" (compare | suite).`);
          const taskId = getStringArg(args, 'taskId', true);
          const patch = parseFilesArg(getStringArg(args, 'patchJson', true), 'patchJson');
          const stepsRaw = getStringArg(args, 'stepsJson');
          const steps = stepsRaw.trim() === '' ? undefined : parseTrajectorySteps(stepsRaw);
          const diffText = getStringArg(args, 'diffText') || buildDiffText(patch);
          const repoRaw = getStringArg(args, 'repoFilesJson');
          const repoFiles = repoRaw.trim() === ''
            ? undefined
            : new Map(Object.entries(parseFilesArg(repoRaw, 'repoFilesJson')));
          const plannedRaw = getStringArg(args, 'plannedFilesJson');
          const plannedFiles = plannedRaw.trim() === '' ? undefined : (JSON.parse(plannedRaw) as string[]);
          const agentZone = getStringArg(args, 'agentZone');
          const config = resolveCriticConfig(dataDir, getStringArg(args, 'criticConfigJson'));
          const comparison = v18RunEvalComparison({
            taskId,
            patch,
            diffText,
            criticConfig: config,
            ...(steps ? { steps } : {}),
            ...(repoFiles ? { repoFiles } : {}),
            ...(plannedFiles ? { plannedFiles } : {}),
            ...(agentZone ? { agentZone } : {}),
          });
          saveEvalComparison(dataDir, comparison);
          return renderV18EvalComparison(comparison);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v18_verify',
        'Run the full coding v18 verification stack for a session: critic on the trajectory (blocks the push when low) + automatic review skill on the patch + dependency-map check (cycles / topo order / zones) + 3-verifier eval. Presentable only when every layer passes.',
        {
          sessionId: { type: 'string', description: 'Session id (trajectory steps owner).' },
          patchJson: { type: 'string', description: 'JSON object path -> new file content (the patch to verify).' },
          stepsJson: { type: 'string', description: 'JSON array of trajectory steps (required).' },
          diffText: { type: 'string', description: 'Diff text (optional; built from patchJson when empty).' },
          repoFilesJson: { type: 'string', description: 'JSON object path -> content for the whole repo (optional).' },
          plannedFilesJson: { type: 'string', description: 'JSON array of planned file paths (optional).' },
          agentZone: { type: 'string', description: 'Zone id of the agent (optional).' },
          criticConfigJson: { type: 'string', description: 'JSON critic config {approveScore, blockScore} (optional).' },
        },
        ['sessionId', 'patchJson', 'stepsJson'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const sessionId = getStringArg(args, 'sessionId', true);
          const patch = parseFilesArg(getStringArg(args, 'patchJson', true), 'patchJson');
          const steps = parseTrajectorySteps(getStringArg(args, 'stepsJson', true));
          if (steps.length === 0) return errorResult('Trajectory rỗng — chưa có phiên để verify.');
          const diffText = getStringArg(args, 'diffText') || buildDiffText(patch);
          const repoRaw = getStringArg(args, 'repoFilesJson');
          const repoFiles = repoRaw.trim() === ''
            ? undefined
            : new Map(Object.entries(parseFilesArg(repoRaw, 'repoFilesJson')));
          const plannedRaw = getStringArg(args, 'plannedFilesJson');
          const plannedFiles = plannedRaw.trim() === '' ? undefined : (JSON.parse(plannedRaw) as string[]);
          const agentZone = getStringArg(args, 'agentZone');
          const dataDir = resolveDataDir(ctx);
          const config = resolveCriticConfig(dataDir, getStringArg(args, 'criticConfigJson'));

          const critic = v18ScoreTrajectory(sessionId, steps, {
            ...(plannedFiles ? { plannedFiles } : {}),
            config,
          });
          const history = v18AppendCriticHistory(v18LoadCriticHistory(criticHistoryFile(dataDir)), critic, critic.reasons[0] ?? critic.verdict);
          v18SaveCriticHistory(criticHistoryFile(dataDir), history);
          const review = v18ReviewPatch(patch, diffText, {});
          const comparison = v18RunEvalComparison({
            taskId: sessionId,
            steps,
            patch,
            diffText,
            criticConfig: config,
            ...(repoFiles ? { repoFiles } : {}),
            ...(plannedFiles ? { plannedFiles } : {}),
            ...(agentZone ? { agentZone } : {}),
          });
          saveEvalComparison(dataDir, comparison);

          const failingLayers: string[] = [];
          if (critic.verdict !== 'approve') failingLayers.push('critic');
          if (review.verdict !== 'pass') failingLayers.push('review-skill');
          const depResult = comparison.results.find((r) => r.verifier === 'dependency-map');
          if (depResult && !depResult.passed) failingLayers.push('dependency-map');
          if (!comparison.allPassed) failingLayers.push('eval-3-verifiers');
          const blockedPush = critic.blocked || review.verdict === 'fail';
          const lines = [
            `Verification stack v18 ${sessionId}: ${failingLayers.length === 0 ? 'ALL PASSED — presentable' : 'FAILED — không được trình'}${blockedPush ? ' — CHẶN PUSH' : ''}.`,
            renderV18CriticVerdict(critic),
            renderV18ReviewReport(review),
            renderV18EvalComparison(comparison),
          ];
          if (failingLayers.length > 0) lines.push(`Tầng chưa pass: ${failingLayers.join(', ')}.`);
          return lines.join('\n');
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v18_agent',
        'Run a scripted coding v18 agent session end-to-end (trajectory + patch + verification stack v18: critic with push-block + review skill + dependency-map check + 3-verifier eval). No real model calls; steps are supplied as JSON.',
        {
          sessionId: { type: 'string', description: 'Session id (unique).' },
          task: { type: 'string', description: 'Task description.' },
          botId: { type: 'string', description: 'Bot id.' },
          stepsJson: { type: 'string', description: 'JSON array of steps {text, bashCommand?, fileWrite? {path, content, kind, oldText?}, isTest?, done?}.' },
          repoFilesJson: { type: 'string', description: 'JSON object path -> content for the repo (optional; dependency-map check).' },
          agentZone: { type: 'string', description: 'Zone id of the agent (optional; zone-conflict check).' },
          criticConfigJson: { type: 'string', description: 'JSON critic config {approveScore, blockScore} (optional).' },
        },
        ['sessionId', 'task', 'botId', 'stepsJson'],
      ),
      needsApproval: true,
      execute: async (args, ctx) => {
        try {
          const sessionId = getStringArg(args, 'sessionId', true);
          const task = getStringArg(args, 'task', true);
          const botId = getStringArg(args, 'botId', true);
          const steps = JSON.parse(getStringArg(args, 'stepsJson', true)) as Array<{
            text: string;
            bashCommand?: string;
            fileWrite?: { path: string; content: string; kind: 'create' | 'write' | 'edit'; oldText?: string };
            isTest?: boolean;
            done?: boolean;
          }>;
          const repoRaw = getStringArg(args, 'repoFilesJson');
          const repoFiles = repoRaw.trim() === ''
            ? undefined
            : new Map(Object.entries(parseFilesArg(repoRaw, 'repoFilesJson')));
          const agentZone = getStringArg(args, 'agentZone');
          const dataDir = resolveDataDir(ctx);
          const config = resolveCriticConfig(dataDir, getStringArg(args, 'criticConfigJson'));
          const report = runV18Agent({
            sessionId,
            task,
            botId,
            steps,
            criticConfig: config,
            ...(repoFiles ? { repoFiles } : {}),
            ...(agentZone ? { agentZone } : {}),
          });
          // Lưu verdict critic của phiên vào lịch sử.
          const history = v18AppendCriticHistory(
            v18LoadCriticHistory(criticHistoryFile(dataDir)),
            report.critic,
            report.critic.reasons[0] ?? report.critic.verdict,
          );
          v18SaveCriticHistory(criticHistoryFile(dataDir), history);
          return renderV18AgentReport(report);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v18_config',
        'View or set the coding v18 configuration: critic approve/block thresholds (or a preset: strict | balanced | lenient) and enabled/disabled review rules (persisted in the v18 data dir).',
        {
          action: { type: 'string', description: 'Action: get | set.' },
          criticConfigJson: { type: 'string', description: 'JSON critic config {approveScore, blockScore} (for set).' },
          preset: { type: 'string', description: 'Critic preset name: strict | balanced | lenient (for set; overrides criticConfigJson).' },
          disabledReviewRulesJson: { type: 'string', description: 'JSON array of review rule ids to disable (for set; empty array re-enables all).' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          if (action === 'get') {
            const stored = loadStoredConfig(dataDir);
            const critic = stored.critic ? v18ValidateCriticConfig(stored.critic) : V18_DEFAULT_CRITIC_CONFIG;
            const disabled = stored.disabledReviewRules ?? [];
            return [
              `Cấu hình coding v18: critic approve >= ${critic.approveScore}, block < ${critic.blockScore}.`,
              `Review rules tắt: ${disabled.length > 0 ? disabled.join(', ') : '(không có — chạy đủ ${V18_REVIEW_RULES.length} rules)'}.`,
              `Review rules có: ${V18_REVIEW_RULES.map((r) => `${r.id}(${r.severity})`).join(', ')}.`,
            ].join('\n');
          }
          if (action === 'set') {
            const stored = loadStoredConfig(dataDir);
            const preset = getStringArg(args, 'preset');
            if (preset.trim() !== '') {
              if (preset !== 'strict' && preset !== 'balanced' && preset !== 'lenient') {
                return errorResult(`Không có critic preset "${preset}" (strict | balanced | lenient).`);
              }
              stored.critic = v18CriticPreset(preset);
            }
            const raw = getStringArg(args, 'criticConfigJson');
            if (raw.trim() !== '') {
              const obj = parseJsonObjectArg(raw, 'criticConfigJson');
              stored.critic = v18ValidateCriticConfig({
                approveScore: typeof obj['approveScore'] === 'number' ? obj['approveScore'] : V18_DEFAULT_CRITIC_CONFIG.approveScore,
                blockScore: typeof obj['blockScore'] === 'number' ? obj['blockScore'] : V18_DEFAULT_CRITIC_CONFIG.blockScore,
                weights: (obj['weights'] as V18CriticConfig['weights']) ?? undefined,
                disabledDimensions: (obj['disabledDimensions'] as V18CriticConfig['disabledDimensions']) ?? undefined,
              });
            }
            const disabledRaw = getStringArg(args, 'disabledReviewRulesJson');
            if (disabledRaw.trim() !== '') {
              const disabled = JSON.parse(disabledRaw) as string[];
              for (const ruleId of disabled) {
                if (!V18_REVIEW_RULES.some((r) => r.id === ruleId)) {
                  return errorResult(`Không có review rule "${ruleId}".`);
                }
              }
              stored.disabledReviewRules = disabled;
            }
            writeJsonFile(configFile(dataDir), stored);
            const critic = stored.critic ?? V18_DEFAULT_CRITIC_CONFIG;
            return `Đã lưu cấu hình coding v18: critic approve >= ${critic.approveScore}, block < ${critic.blockScore}; review rules tắt: ${(stored.disabledReviewRules ?? []).join(', ') || '(không có)'}.`;
          }
          return errorResult(`Unknown action "${action}" (get | set).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
  ];
  return tools;
}

/** Placeholder tools (ALL_TOOLS) — host thay bằng bản bound khi có base dir. */
export const CODING_V18_TOOLS: Tool[] = createCodingV18Tools();

/** Đảm bảo base dir có thư mục dữ liệu v18 (dùng khi host bind). */
export function codingV18EnsureBaseDir(baseDir: string): string {
  return codingV18EnsureDataDir(baseDir);
}
