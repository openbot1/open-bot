/**
 * Fleet v4 Teams tools (v1.07, Đội T6) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * - `fleet_v4_team_create` — tạo một Agent Team peer (điều phối viên
 *   + member + workstream có lát cắt sở hữu không chồng nhau), lưu
 *   vào `<userData>/fleet/agent-teams-v107.json`. Chồng slice →
 *   lỗi rõ ràng, team không được tạo.
 * - `fleet_v4_team_status` — trạng thái team (một team theo id hoặc
 *   tất cả): member, workstream, done/failed/skipped/pending.
 * - `fleet_v4_team_worktree` — lập kế hoạch worktree isolation cho
 *   một member/child: validate tên branch, tính đường dẫn worktree
 *   ngoài repo root. CHỈ LẬP KẾ HOẠCH — không chạy git (host quyết
 *   định khi nào tạo worktree thật). Không cần baseDir nên chạy được
 *   cả khi chưa bind.
 * - `fleet_v4_context_strategy` — router context strategy cho một
 *   model + số token đã dùng: window resolve được, tỉ lệ đã dùng,
 *   chiến lược nén (none/summarize/compress/truncate), ngân sách
 *   chia ngăn, và gợi ý đích window lớn hơn khi đã phải cắt cứng.
 *   Tính toán thuần nên chạy được cả khi chưa bind.
 * - `fleet_v4_prompt_cache` — thống kê / invalidate / clear cache
 *   prompt đã biên dịch theo hash (`compiled-prompt-cache-v107.json`
 *   trong fleet root): full hit, block hit/miss, token ước tính tiết
 *   kiệm được.
 *
 * Như các tool fleet trước, đây là placeholder trong ALL_TOOLS cho
 * tới khi host bind: `createFleetV4TeamsTools(getBaseDir)` với
 * userData dir của app. Tool ghi file (team_create, prompt_cache
 * invalidate/clear) cần approval; tool chỉ đọc / tính toán thì không.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  AGENT_TEAMS_FILE,
  assessTurnContext,
  buildReturnEnvelope,
  createAgentTeam,
  findAgentTeam,
  loadAgentTeams,
  loadPromptCache,
  planWorktree,
  saveAgentTeams,
  savePromptCache,
  summarizeAgentTeam,
  validateBranchName,
  type AgentTeamMemberRole,
  type CreateTeamMemberInput,
  type CreateTeamWorkstreamInput,
  type RouterTarget,
} from '@open-bot/core';

export const FLEET_V4_TEAMS_TOOL_NAMES = [
  'fleet_v4_team_create',
  'fleet_v4_team_status',
  'fleet_v4_team_worktree',
  'fleet_v4_context_strategy',
  'fleet_v4_prompt_cache',
] as const;

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

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
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

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getObjectArrayArg(args: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return value as Record<string, unknown>[];
}

function getStringArrayField(obj: Record<string, unknown>, name: string): string[] {
  const value = obj[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Field "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

const NOT_WIRED =
  'fleet v4 teams tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root derived from the app userData dir. */
function dirs(baseDir: string): { fleetRoot: string } {
  return { fleetRoot: path.join(baseDir, 'fleet') };
}

const TEAM_MEMBER_ROLES: AgentTeamMemberRole[] = [
  'coordinator',
  'researcher',
  'implementer',
  'reviewer',
  'specialist',
];

function parseTeamMembers(args: Record<string, unknown>): CreateTeamMemberInput[] {
  const raw = getObjectArrayArg(args, 'members');
  if (raw.length === 0) throw new Error('Team cần ít nhất 1 member (members không được rỗng).');
  return raw.map((m, i) => {
    const name = m['name'];
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`members[${i}] cần name không rỗng.`);
    }
    const role = m['role'];
    if (typeof role !== 'string' || !(TEAM_MEMBER_ROLES as string[]).includes(role)) {
      throw new Error(`members[${i}] role phải là một trong: ${TEAM_MEMBER_ROLES.join(', ')}.`);
    }
    const model = m['model'];
    if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
      throw new Error(`members[${i}] model (nếu có) phải là chuỗi không rỗng.`);
    }
    return {
      name: (name as string).trim(),
      role: role as AgentTeamMemberRole,
      ...(typeof model === 'string' ? { model: (model as string).trim() } : {}),
    };
  });
}

function parseTeamWorkstreams(args: Record<string, unknown>): CreateTeamWorkstreamInput[] {
  const raw = getObjectArrayArg(args, 'workstreams');
  return raw.map((w, i) => {
    const id = w['id'];
    const title = w['title'];
    const brief = w['brief'];
    const ownerName = w['ownerName'];
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error(`workstreams[${i}] cần id không rỗng.`);
    if (typeof title !== 'string' || title.trim().length === 0) throw new Error(`workstreams[${i}] cần title không rỗng.`);
    if (typeof brief !== 'string' || brief.trim().length === 0) throw new Error(`workstreams[${i}] cần brief không rỗng.`);
    if (typeof ownerName !== 'string' || ownerName.trim().length === 0) {
      throw new Error(`workstreams[${i}] cần ownerName không rỗng.`);
    }
    return {
      id: (id as string).trim(),
      title: (title as string).trim(),
      brief: (brief as string).trim(),
      ownerName: (ownerName as string).trim(),
      owns: getStringArrayField(w, 'owns'),
      dependsOn: getStringArrayField(w, 'dependsOn'),
    };
  });
}

function parseRouterCandidates(args: Record<string, unknown>): RouterTarget[] {
  const raw = getObjectArrayArg(args, 'candidates');
  return raw.map((c, i) => {
    const id = c['id'];
    const providerId = c['providerId'];
    const model = c['model'];
    const kind = c['kind'];
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error(`candidates[${i}] cần id không rỗng.`);
    if (typeof providerId !== 'string' || providerId.trim().length === 0) {
      throw new Error(`candidates[${i}] cần providerId không rỗng.`);
    }
    if (typeof model !== 'string' || model.trim().length === 0) throw new Error(`candidates[${i}] cần model không rỗng.`);
    if (kind !== 'local' && kind !== 'cli' && kind !== 'api') {
      throw new Error(`candidates[${i}] kind phải là local/cli/api.`);
    }
    const target: RouterTarget = {
      id: (id as string).trim(),
      providerId: (providerId as string).trim(),
      model: (model as string).trim(),
      kind,
    };
    if (typeof c['contextLimit'] === 'number') target.contextLimit = c['contextLimit'] as number;
    if (typeof c['costPer1kUsd'] === 'number') target.costPer1kUsd = c['costPer1kUsd'] as number;
    return target;
  });
}

const MEMBER_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Member display name (unique in the team).' },
    role: { type: 'string', enum: [...TEAM_MEMBER_ROLES], description: 'Member role: coordinator runs the team, others own workstreams.' },
    model: { type: 'string', description: 'Optional: model this member runs (default = team default model).' },
  },
  required: ['name', 'role'],
  additionalProperties: false,
};

const WORKSTREAM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Workstream id, unique in the team (e.g. "research-memory").' },
    title: { type: 'string', description: 'Short workstream title.' },
    brief: { type: 'string', description: 'What the owner must do (no secrets).' },
    ownerName: { type: 'string', description: 'Name of the member owning this slice.' },
    owns: { type: 'array', items: { type: 'string' }, description: 'Owned slices: path prefixes or abstract keys. Two workstreams must not overlap.' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of workstreams that must finish first.' },
  },
  required: ['id', 'title', 'brief', 'ownerName'],
  additionalProperties: false,
};

/**
 * Build the 5 fleet v4 teams tools. `getBaseDir` resolves the app
 * userData dir (null/undefined = unbound placeholders that explain
 * themselves instead of guessing paths). `fleet_v4_team_worktree`
 * and `fleet_v4_context_strategy` are pure computation and run even
 * unbound — they touch no files.
 */
export function createFleetV4TeamsTools(
  getBaseDir?: () => string | null | undefined,
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const teamCreateTool: Tool = {
    definition: toolDef(
      'fleet_v4_team_create',
      'Create an Agent Team: peer agents coordinated by one coordinator, each owning a non-overlapping workstream slice that runs in parallel. Validates slice overlap, coordinator role and workstream owners before saving. Saved to <userData>/fleet/agent-teams-v107.json.',
      {
        name: { type: 'string', description: 'Team name (unique in the teams file).' },
        goal: { type: 'string', description: 'Shared goal of the team.' },
        coordinatorName: { type: 'string', description: 'Name of the member with role coordinator.' },
        members: { type: 'array', items: MEMBER_SCHEMA, description: 'Team members (at least 1, coordinator included).' },
        workstreams: { type: 'array', items: WORKSTREAM_SCHEMA, description: 'Workstreams, each owned by one member with non-overlapping slices.' },
      },
      ['name', 'goal', 'coordinatorName', 'members'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const teams = loadAgentTeams(fleetRoot);
        const name = getStringArg(args, 'name');
        if (teams.some((t) => t.name.toLowerCase() === name.trim().toLowerCase())) {
          return errorResult(`Đã có team tên "${name.trim()}" — đặt tên khác.`);
        }
        const team = createAgentTeam({
          name,
          goal: getStringArg(args, 'goal'),
          coordinatorName: getStringArg(args, 'coordinatorName'),
          members: parseTeamMembers(args),
          workstreams: parseTeamWorkstreams(args),
        });
        saveAgentTeams(fleetRoot, [...teams, team]);
        return JSON.stringify(
          { team: summarizeAgentTeam(team), file: AGENT_TEAMS_FILE, members: team.members.map((m) => ({ id: m.id, name: m.name, role: m.role })) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const teamStatusTool: Tool = {
    definition: toolDef(
      'fleet_v4_team_status',
      'Agent Team status: list all teams (id, name, members, workstream counts) or one team by id with full member + workstream states. Read-only, local only.',
      {
        teamId: { type: 'string', description: 'Optional: only show this team.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const teams = loadAgentTeams(fleetRoot);
        const teamId = getStringArg(args, 'teamId', false);
        if (teamId) {
          const team = findAgentTeam(teams, teamId);
          if (!team) return errorResult(`Không có team "${teamId}".`);
          return JSON.stringify(
            {
              team: summarizeAgentTeam(team),
              goal: team.goal,
              coordinatorId: team.coordinatorId,
              members: team.members,
              workstreams: team.workstreams,
              recentEvents: team.events.slice(-10),
            },
            null,
            2,
          ).slice(0, 20000);
        }
        return JSON.stringify(
          { count: teams.length, teams: teams.map(summarizeAgentTeam) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const teamWorktreeTool: Tool = {
    definition: toolDef(
      'fleet_v4_team_worktree',
      'Plan subagent worktree isolation (context firewall): validate the branch name and compute the worktree path OUTSIDE the repo root, returning the exact git argv. PLAN ONLY — does not run git; the host creates the worktree when it dispatches the child. Runs even when the tools are not wired.',
      {
        repoRoot: { type: 'string', description: 'Absolute path to the repo the child works on.' },
        branch: { type: 'string', description: 'Branch the child will work on (git-validated).' },
        baseBranch: { type: 'string', description: 'Optional: branch to branch off from (default HEAD).' },
        worktreeParent: { type: 'string', description: 'Optional: absolute parent dir for the worktree (default: parent of repoRoot).' },
      },
      ['repoRoot', 'branch'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const branch = validateBranchName(getStringArg(args, 'branch'));
        const plan = planWorktree({
          repoRoot: getStringArg(args, 'repoRoot'),
          branch,
          baseBranch: getStringArg(args, 'baseBranch', false) || undefined,
          worktreeParent: getStringArg(args, 'worktreeParent', false) || undefined,
        });
        // Minh hoạ firewall: envelope mẫu cho branch này (chưa có kết quả thật).
        const envelope = buildReturnEnvelope({
          plan,
          status: 'partial',
          summary: 'Worktree đã lên kế hoạch — child chưa chạy nên chưa có kết quả.',
          artifacts: [],
          toolCalls: [],
          durationMs: 0,
        });
        return JSON.stringify(
          {
            plan: { repoRoot: plan.repoRoot, branch: plan.branch, baseBranch: plan.baseBranch, worktreePath: plan.worktreePath, gitArgs: plan.gitArgs },
            note: 'Plan only — host runs: git -C <repoRoot> worktree add <worktreePath> -b <branch> <baseBranch>. The child returns ONLY the envelope (branch + compressed summary), never raw tool calls.',
            sampleEnvelope: { branch: envelope.branch, worktreePath: envelope.worktreePath, status: envelope.status },
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const contextStrategyTool: Tool = {
    definition: toolDef(
      'fleet_v4_context_strategy',
      'Router context strategy for a model + tokens already used: resolves the model context window (exact model, then family, then provider default), picks the compaction strategy (none / summarize-oldest / compress / truncate-hard), plans the window budget split, and suggests a larger-window target when truncation is unavoidable. Pure computation — runs even when the tools are not wired.',
      {
        model: { type: 'string', description: 'Model id (e.g. claude-sonnet-4-5, gpt-5, gemini-2.5-flash).' },
        providerId: { type: 'string', description: 'Optional: provider id for the provider-default fallback.' },
        usedTokens: { type: 'number', description: 'Tokens already used in this turn (system + memory + history).' },
        reserveTokens: { type: 'number', description: 'Optional: tokens reserved for the reply (default 4000).' },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              providerId: { type: 'string' },
              model: { type: 'string' },
              kind: { type: 'string', enum: ['local', 'cli', 'api'] },
              contextLimit: { type: 'number' },
            },
            required: ['id', 'providerId', 'model', 'kind'],
            additionalProperties: false,
          },
          description: 'Optional: other routing targets to consider for a larger-window suggestion.',
        },
      },
      ['model', 'usedTokens'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const model = getStringArg(args, 'model');
        const providerId = getStringArg(args, 'providerId', false) || undefined;
        const usedTokens = getNumberArg(args, 'usedTokens', 0);
        if (usedTokens < 0) return errorResult('usedTokens must be >= 0.');
        const reserve = getNumberArg(args, 'reserveTokens', 4000);
        const candidates = parseRouterCandidates(args);
        const target: RouterTarget = {
          id: 'current',
          providerId: providerId ?? 'unknown',
          model,
          kind: 'api',
        };
        const assessment = assessTurnContext(target, usedTokens, candidates, { reserveTokens: reserve });
        return JSON.stringify(
          {
            model: assessment.resolved.model,
            providerId: assessment.resolved.providerId ?? null,
            windowTokens: assessment.resolved.windowTokens,
            windowSource: assessment.resolved.source,
            usedTokens: assessment.usedTokens,
            usageRatio: Number(assessment.usageRatio.toFixed(4)),
            headroomTokens: assessment.headroomTokens,
            strategy: assessment.strategy,
            needsCompaction: assessment.needsCompaction,
            reason: assessment.reason,
            budget: assessment.budget,
            largerWindowSuggestion: assessment.largerWindowSuggestion
              ? {
                  targetId: assessment.largerWindowSuggestion.target.id,
                  model: assessment.largerWindowSuggestion.target.model,
                  windowTokens: assessment.largerWindowSuggestion.windowTokens,
                  gainRatio: Number(assessment.largerWindowSuggestion.gainRatio.toFixed(2)),
                }
              : null,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const promptCacheTool: Tool = {
    definition: toolDef(
      'fleet_v4_prompt_cache',
      'Compiled prompt cache (hash-based): stats shows full hits, block hits/misses and estimated tokens saved by reusing compiled memory blocks; invalidate drops one block label from the cache (forces recompile); clear drops the whole cache. State lives in <userData>/fleet/compiled-prompt-cache-v107.json.',
      {
        action: { type: 'string', enum: ['stats', 'invalidate', 'clear'], description: 'stats (read-only), invalidate (one label), or clear (whole cache).' },
        label: { type: 'string', description: 'Block label for action=invalidate (e.g. "human").' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const action = getStringArg(args, 'action');
        if (action !== 'stats' && action !== 'invalidate' && action !== 'clear') {
          return errorResult('action must be one of: stats, invalidate, clear.');
        }
        const cache = loadPromptCache(fleetRoot);
        if (action === 'stats') {
          return JSON.stringify({ stats: cache.getStats(), promptHash: cache.promptHash || null }, null, 2);
        }
        if (action === 'invalidate') {
          const label = getStringArg(args, 'label');
          cache.invalidate(label);
          savePromptCache(fleetRoot, cache);
          return JSON.stringify({ action: 'invalidate', label, stats: cache.getStats() }, null, 2);
        }
        cache.clear();
        // Tool "clear" = xoá toàn bộ trạng thái cache (cả số liệu) để
        // user bắt đầu lại từ đầu; core clear() chỉ xoá cache giữ stats.
        cache.resetStats();
        savePromptCache(fleetRoot, cache);
        return JSON.stringify({ action: 'clear', stats: cache.getStats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [teamCreateTool, teamStatusTool, teamWorktreeTool, contextStrategyTool, promptCacheTool];
}

/**
 * Unbound placeholders, registered in ALL_TOOLS (see tools.ts).
 * The two pure tools (worktree plan, context strategy) execute even
 * unbound; the three file-backed tools answer NOT_WIRED until the
 * host binds a base dir.
 */
export const FLEET_V4_TEAMS_TOOLS: Tool[] = createFleetV4TeamsTools();
