/**
 * Doctor checks (v1.06, Team T5 — UI v3).
 *
 * There is no `doctor` command in the repo yet, so the Doctor panel
 * does not invent one: it aggregates the health signals the app
 * already exposes over IPC — detected CLI engines (`engines:list`),
 * Ollama embedding availability (`memory:status`), memory health
 * (`memory-v5:health`), failing MCP tasks (`mcp-tasks:list`) and the
 * loaded team (`team:get`) — into one pass/warn/fail checklist.
 *
 * `evaluateDoctor` is pure (unit-testable without IPC);
 * `runDoctorChecks` is the thin async aggregator that calls the real
 * IPC and never lets one failing source hide the other checks.
 */
import type {
  DetectedEnginesView,
  McpTaskViewLike,
  MemoryV5HealthView,
  TeamConfigLike,
} from '../types';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export type DoctorCheckId = 'engines' | 'ollama' | 'memoryHealth' | 'mcpTasks' | 'team';

export interface DoctorCheckResult {
  id: DoctorCheckId;
  status: DoctorStatus;
  /** i18n key for the one-line detail (interpolated with `vars`). */
  detailKey: string;
  vars?: Record<string, string | number>;
}

export interface DoctorInput {
  /** Total detected engines (0 = the detector returned nothing). */
  enginesTotal: number;
  /** Engines whose status is 'available'. */
  enginesAvailable: number;
  /** Ollama reachable for embeddings (null = unknown / no bot selected). */
  ollamaAvailable: boolean | null;
  /** Memory health score 0..100 (null = no bot / health unavailable). */
  memoryScore: number | null;
  /** Number of failed MCP tasks right now. */
  tasksFailed: number;
  /** Team config loaded (null = the IPC call itself failed). */
  team: TeamConfigLike | null;
  /** Shared bots on the team (0 when the team has none). */
  teamSharedBots: number;
}

/** Static check id -> i18n label key map (kept literal so the key scan finds every key). */
export const DOCTOR_CHECK_LABEL_KEYS: Record<DoctorCheckId, string> = {
  engines: 'doctorTeam.check.engines',
  ollama: 'doctorTeam.check.ollama',
  memoryHealth: 'doctorTeam.check.memoryHealth',
  mcpTasks: 'doctorTeam.check.mcpTasks',
  team: 'doctorTeam.check.team',
};

/** Pure evaluation: numbers in, checklist out. */
export function evaluateDoctor(input: DoctorInput): DoctorCheckResult[] {
  const checks: DoctorCheckResult[] = [];

  if (input.enginesTotal === 0) {
    checks.push({
      id: 'engines',
      status: 'fail',
      detailKey: 'doctorTeam.detail.enginesNone',
    });
  } else if (input.enginesAvailable === 0) {
    checks.push({
      id: 'engines',
      status: 'fail',
      detailKey: 'doctorTeam.detail.enginesNoneAvailable',
      vars: { total: input.enginesTotal },
    });
  } else if (input.enginesAvailable < input.enginesTotal) {
    checks.push({
      id: 'engines',
      status: 'warn',
      detailKey: 'doctorTeam.detail.enginesAvailable',
      vars: { available: input.enginesAvailable, total: input.enginesTotal },
    });
  } else {
    checks.push({
      id: 'engines',
      status: 'pass',
      detailKey: 'doctorTeam.detail.enginesAvailable',
      vars: { available: input.enginesAvailable, total: input.enginesTotal },
    });
  }

  if (input.ollamaAvailable === null) {
    checks.push({ id: 'ollama', status: 'warn', detailKey: 'doctorTeam.detail.ollamaUnknown' });
  } else if (input.ollamaAvailable) {
    checks.push({ id: 'ollama', status: 'pass', detailKey: 'doctorTeam.detail.ollamaOn' });
  } else {
    checks.push({ id: 'ollama', status: 'warn', detailKey: 'doctorTeam.detail.ollamaOff' });
  }

  if (input.memoryScore === null) {
    checks.push({ id: 'memoryHealth', status: 'fail', detailKey: 'doctorTeam.detail.memoryNoBot' });
  } else if (input.memoryScore >= 80) {
    checks.push({
      id: 'memoryHealth',
      status: 'pass',
      detailKey: 'doctorTeam.detail.memoryScore',
      vars: { score: input.memoryScore },
    });
  } else if (input.memoryScore >= 50) {
    checks.push({
      id: 'memoryHealth',
      status: 'warn',
      detailKey: 'doctorTeam.detail.memoryScore',
      vars: { score: input.memoryScore },
    });
  } else {
    checks.push({
      id: 'memoryHealth',
      status: 'fail',
      detailKey: 'doctorTeam.detail.memoryScore',
      vars: { score: input.memoryScore },
    });
  }

  if (input.tasksFailed > 0) {
    checks.push({
      id: 'mcpTasks',
      status: 'warn',
      detailKey: 'doctorTeam.detail.tasksFailed',
      vars: { count: input.tasksFailed },
    });
  } else {
    checks.push({ id: 'mcpTasks', status: 'pass', detailKey: 'doctorTeam.detail.tasksOk' });
  }

  if (input.team === null) {
    checks.push({ id: 'team', status: 'fail', detailKey: 'doctorTeam.detail.teamMissing' });
  } else {
    checks.push({
      id: 'team',
      status: 'pass',
      detailKey: 'doctorTeam.detail.teamOk',
      vars: { members: input.team.members.length, bots: input.teamSharedBots },
    });
  }

  return checks;
}

/** Minimal shape of `window.openBot` the doctor runner needs. */
export interface DoctorOpenBot {
  listEngines: () => Promise<unknown>;
  getMemoryStatus: (payload: { botId: string }) => Promise<{
    total: number;
    embedded: number;
    ollamaAvailable: boolean;
    embeddingModel: string;
  }>;
  getMemoryV5Health: (payload: { botId: string }) => Promise<{
    health: MemoryV5HealthView;
    contradictionGroups: unknown;
    recentConsolidationRuns: unknown;
  }>;
  listMcpTasks: () => Promise<McpTaskViewLike[]>;
  getTeam: () => Promise<unknown>;
}

/**
 * Run every doctor probe against the real IPC. Each probe is
 * independent: a failure only degrades its own check (fail for
 * engines/team/memory, warn for ollama) and never aborts the run.
 */
export async function runDoctorChecks(
  openBot: DoctorOpenBot,
  botId: string | null,
): Promise<DoctorCheckResult[]> {
  let enginesTotal = 0;
  let enginesAvailable = 0;
  try {
    const snapshot = (await openBot.listEngines()) as DetectedEnginesView | null;
    const engines = snapshot ? Object.values(snapshot.engines ?? {}) : [];
    enginesTotal = engines.length;
    enginesAvailable = engines.filter((e) => e.status === 'available').length;
  } catch {
    enginesTotal = 0;
    enginesAvailable = 0;
  }

  let ollamaAvailable: boolean | null = null;
  let memoryScore: number | null = null;
  if (botId) {
    try {
      const status = await openBot.getMemoryStatus({ botId });
      ollamaAvailable = status.ollamaAvailable;
    } catch {
      ollamaAvailable = null;
    }
    try {
      const res = await openBot.getMemoryV5Health({ botId });
      memoryScore = res.health.score;
    } catch {
      memoryScore = null;
    }
  }

  let tasksFailed = 0;
  try {
    const tasks = await openBot.listMcpTasks();
    tasksFailed = tasks.filter((t) => t.status === 'failed').length;
  } catch {
    tasksFailed = 0;
  }

  let team: TeamConfigLike | null = null;
  let teamSharedBots = 0;
  try {
    const loaded = (await openBot.getTeam()) as TeamConfigLike | null;
    if (loaded && typeof loaded === 'object' && Array.isArray(loaded.members)) {
      team = loaded;
      teamSharedBots = Array.isArray(loaded.sharedBots) ? loaded.sharedBots.length : 0;
    }
  } catch {
    team = null;
  }

  return evaluateDoctor({
    enginesTotal,
    enginesAvailable,
    ollamaAvailable,
    memoryScore,
    tasksFailed,
    team,
    teamSharedBots,
  });
}
