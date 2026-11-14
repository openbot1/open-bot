/**
 * Team YAML — định nghĩa team bằng file YAML (v1.05, Đội T3).
 *
 * Học ý tưởng "team as code" từ các agent headless (định nghĩa team
 * bằng file, apply từ CLI) nhưng schema viết mới hoàn toàn cho
 * open-bot, dùng lại YAML subset có sẵn của repo (`policy/yaml.ts`,
 * v1.04 — không thêm dependency, không viết parser thứ hai).
 *
 * Định dạng (version 1):
 * ```yaml
 * version: 1
 * team:
 *   id: team-alpha
 *   name: Đội Alpha
 *   workspaceDir: /data/shared   # optional
 * members:
 *   - userId: local
 *     name: Huy
 *     role: admin
 * bots:
 *   - botId: assistant
 *     provider: gemini          # optional, ghi nhớ model chạy bằng gì
 *     model: gemini-2.5-flash   # optional
 *     sharedBy: local           # optional, mặc định userId đầu tiên
 *     computer:                 # optional, xem compute/quota.ts
 *       level: box
 *       cpuCores: 2
 *       memoryMb: 1024
 *       diskMb: 5120
 * ```
 *
 * `applyTeamYaml` validate rồi ghi `team.json` (qua `saveTeamConfig`)
 * + quota máy-tính-bot vào `team-computers.json`. `exportTeamYaml`
 * làm chiều ngược lại từ team hiện có. `provider`/`model` của bot
 * KHÔNG lưu vào team.json (TeamConfig không có field đó) — chúng
 * được giữ trong file YAML export dưới dạng ghi chú `bots:` kèm
 * `sharedBy`, còn quota computer lưu riêng; khi export mà team.json
 * không có thông tin model thì mục bots chỉ có botId + sharedBy.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadBotComputerQuotas, saveBotComputerQuotas, upsertBotComputerQuota, validateBotComputerQuota } from '../compute/quota';
import type { BotComputerQuota } from '../compute/quota';
import { emitYamlSubset, parseYamlSubset, PolicyYamlError } from '../policy/yaml';
import type { TeamConfig, TeamMember, TeamRole } from './types';
import { TEAM_ROLES } from './types';
import { loadTeamConfig, saveTeamConfig, validateTeamConfig } from './team';

/** Phiên bản schema team YAML duy nhất hiện hỗ trợ. */
export const TEAM_YAML_VERSION = 1;

/** Một bot trong file team YAML. */
export interface TeamYamlBot {
  botId: string;
  provider?: string;
  model?: string;
  sharedBy?: string;
  computer?: BotComputerQuota;
}

/** Nội dung đã parse + validate của một file team YAML. */
export interface TeamYamlDocument {
  version: 1;
  team: { id: string; name: string; workspaceDir?: string };
  members: TeamMember[];
  bots: TeamYamlBot[];
}

/** Kết quả apply (kể cả dry-run). */
export interface TeamYamlApplyResult {
  /** true khi dry-run (không ghi file nào). */
  dryRun: boolean;
  team: TeamConfig;
  /** Số quota máy-tính-bot đi kèm. */
  computerQuotas: number;
  /** Đường dẫn team.json đã ghi (dry-run thì vẫn là đích sẽ ghi). */
  teamPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`team YAML: "${field}" phải là chuỗi không rỗng.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`team YAML: "${field}" phải là chuỗi không rỗng khi có mặt.`);
  }
  return value.trim();
}

/**
 * Parse + validate text YAML thành TeamYamlDocument.
 * Throw Error (hoặc YamlError) với message rõ ràng khi sai.
 */
export function parseTeamYaml(text: string): TeamYamlDocument {
  let parsed: unknown;
  try {
    parsed = parseYamlSubset(text);
  } catch (err) {
    if (err instanceof PolicyYamlError) throw new Error(`team YAML: ${err.message}`);
    throw new Error(`team YAML: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error('team YAML: cấp cao nhất phải là một map.');
  if (parsed['version'] !== TEAM_YAML_VERSION) {
    throw new Error(`team YAML: "version" phải là ${TEAM_YAML_VERSION} (nhận được ${JSON.stringify(parsed['version'] ?? null)}).`);
  }
  if (!isRecord(parsed['team'])) throw new Error('team YAML: thiếu mục "team" (map với id + name).');
  const team = {
    id: nonEmptyString(parsed['team']['id'], 'team.id'),
    name: nonEmptyString(parsed['team']['name'], 'team.name'),
    workspaceDir: optionalString(parsed['team']['workspaceDir'], 'team.workspaceDir'),
  };

  const members: TeamMember[] = [];
  if (parsed['members'] !== undefined && parsed['members'] !== null) {
    if (!Array.isArray(parsed['members'])) throw new Error('team YAML: "members" phải là danh sách.');
    const seen = new Set<string>();
    for (let i = 0; i < parsed['members'].length; i += 1) {
      const raw = parsed['members'][i];
      if (!isRecord(raw)) throw new Error(`team YAML: members[${i}] phải là map.`);
      const userId = nonEmptyString(raw['userId'], `members[${i}].userId`);
      if (seen.has(userId)) throw new Error(`team YAML: trùng userId "${userId}" trong members.`);
      seen.add(userId);
      const role = raw['role'];
      if (typeof role !== 'string' || !(TEAM_ROLES as readonly string[]).includes(role)) {
        throw new Error(`team YAML: members[${i}].role phải là một trong ${TEAM_ROLES.join(', ')}.`);
      }
      members.push({
        userId,
        name: nonEmptyString(raw['name'], `members[${i}].name`),
        role: role as TeamRole,
      });
    }
  }

  const bots: TeamYamlBot[] = [];
  if (parsed['bots'] !== undefined && parsed['bots'] !== null) {
    if (!Array.isArray(parsed['bots'])) throw new Error('team YAML: "bots" phải là danh sách.');
    const seen = new Set<string>();
    for (let i = 0; i < parsed['bots'].length; i += 1) {
      const raw = parsed['bots'][i];
      if (!isRecord(raw)) throw new Error(`team YAML: bots[${i}] phải là map.`);
      const botId = nonEmptyString(raw['botId'], `bots[${i}].botId`);
      if (seen.has(botId)) throw new Error(`team YAML: trùng botId "${botId}" trong bots.`);
      seen.add(botId);
      const bot: TeamYamlBot = { botId };
      const provider = optionalString(raw['provider'], `bots[${i}].provider`);
      if (provider) bot.provider = provider;
      const model = optionalString(raw['model'], `bots[${i}].model`);
      if (model) bot.model = model;
      const sharedBy = optionalString(raw['sharedBy'], `bots[${i}].sharedBy`);
      if (sharedBy) bot.sharedBy = sharedBy;
      if (raw['computer'] !== undefined && raw['computer'] !== null) {
        try {
          bot.computer = validateBotComputerQuota({ ...(raw['computer'] as Record<string, unknown>), botId });
        } catch (err) {
          throw new Error(`team YAML: bots[${i}].computer không hợp lệ: ${(err as Error).message}`);
        }
      }
      bots.push(bot);
    }
  }
  return { version: 1, team, members, bots };
}

/** Chuyển TeamYamlDocument thành TeamConfig (dùng chung validateTeamConfig). */
export function teamYamlToConfig(doc: TeamYamlDocument): TeamConfig {
  const sharedByDefault = doc.members[0]?.userId ?? '';
  const raw: Record<string, unknown> = {
    id: doc.team.id,
    name: doc.team.name,
    members: doc.members,
    sharedBots: doc.bots.map((b) => ({ botId: b.botId, sharedBy: b.sharedBy ?? sharedByDefault })),
  };
  if (doc.team.workspaceDir) raw['workspaceDir'] = doc.team.workspaceDir;
  return validateTeamConfig(raw);
}

/**
 * Apply team YAML vào dataDir. dryRun=true thì chỉ validate, không
 * ghi file nào. Trả về kết quả (team đã validate + số quota).
 */
export function applyTeamYaml(text: string, dataDir: string, options?: { dryRun?: boolean }): TeamYamlApplyResult {
  const doc = parseTeamYaml(text);
  const team = teamYamlToConfig(doc);
  const quotas = doc.bots.filter((b) => b.computer).map((b) => b.computer as BotComputerQuota);
  const teamPath = path.join(dataDir, 'team.json');
  if (options?.dryRun) {
    return { dryRun: true, team, computerQuotas: quotas.length, teamPath };
  }
  saveTeamConfig(dataDir, team);
  if (quotas.length > 0) {
    let existing: BotComputerQuota[] = [];
    try {
      existing = loadBotComputerQuotas(dataDir);
    } catch {
      existing = [];
    }
    let merged = existing;
    for (const q of quotas) merged = upsertBotComputerQuota(merged, q);
    saveBotComputerQuotas(dataDir, merged);
  }
  return { dryRun: false, team, computerQuotas: quotas.length, teamPath };
}

/**
 * Xuất team hiện có trong dataDir ra YAML text.
 * Quota máy-tính-bot (nếu có) được kèm theo từng bot.
 */
export function exportTeamYaml(dataDir: string): string {
  const team = loadTeamConfig(dataDir);
  let quotas: BotComputerQuota[] = [];
  try {
    quotas = loadBotComputerQuotas(dataDir);
  } catch {
    quotas = [];
  }
  const quotaByBot = new Map(quotas.map((q) => [q.botId, q]));
  const doc: { [key: string]: unknown } = {
    version: TEAM_YAML_VERSION,
    team: {
      id: team.id,
      name: team.name,
      ...(team.workspaceDir ? { workspaceDir: team.workspaceDir } : {}),
    },
    members: team.members.map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
    bots: team.sharedBots.map((b) => {
      const entry: { [key: string]: unknown } = { botId: b.botId, sharedBy: b.sharedBy };
      const quota = quotaByBot.get(b.botId);
      if (quota) {
        const computer: { [key: string]: unknown } = {};
        if (quota.level) computer['level'] = quota.level;
        if (quota.cpuCores !== undefined) computer['cpuCores'] = quota.cpuCores;
        if (quota.memoryMb !== undefined) computer['memoryMb'] = quota.memoryMb;
        if (quota.diskMb !== undefined) computer['diskMb'] = quota.diskMb;
        if (quota.maxProcesses !== undefined) computer['maxProcesses'] = quota.maxProcesses;
        if (Object.keys(computer).length > 0) entry['computer'] = computer;
      }
      return entry;
    }),
  };
  return emitYamlSubset(doc);
}

/** Kết quả so sánh team YAML với team hiện có (chỉ đọc, không ghi). */
export interface TeamYamlDiff {
  /** true khi có bất kỳ thay đổi nào. */
  changed: boolean;
  membersAdded: TeamMember[];
  membersRemoved: TeamMember[];
  membersChanged: Array<{ userId: string; before: TeamMember; after: TeamMember }>;
  botsAdded: TeamYamlBot[];
  botsRemoved: TeamYamlBot[];
  /** Thay đổi sharedBy / computer của bot đã có (provider/model trong YAML chỉ là ghi chú, không lưu vào team.json nên không tính vào diff). */
  botsChanged: Array<{ botId: string; changes: string[] }>;
  quotasAdded: BotComputerQuota[];
  quotasRemoved: BotComputerQuota[];
  quotasChanged: Array<{ botId: string; changes: string[] }>;
}

function quotaChanges(before: BotComputerQuota, after: BotComputerQuota): string[] {
  const changes: string[] = [];
  for (const field of ['level', 'cpuCores', 'memoryMb', 'diskMb', 'maxProcesses'] as const) {
    if (before[field] !== after[field]) {
      changes.push(`${field}: ${String(before[field] ?? '—')} → ${String(after[field] ?? '—')}`);
    }
  }
  return changes;
}

/**
 * So sánh một TeamConfig + quota mới với team hiện có trong dataDir.
 * Dùng chung cho YAML và JSON (CLI `team diff`).
 */
export function diffTeamConfig(
  newTeam: TeamConfig,
  newQuotas: BotComputerQuota[],
  dataDir: string,
): TeamYamlDiff {
  const current = loadTeamConfig(dataDir);
  let currentQuotas: BotComputerQuota[] = [];
  try {
    currentQuotas = loadBotComputerQuotas(dataDir);
  } catch {
    currentQuotas = [];
  }
  const diff: TeamYamlDiff = {
    changed: false,
    membersAdded: [],
    membersRemoved: [],
    membersChanged: [],
    botsAdded: [],
    botsRemoved: [],
    botsChanged: [],
    quotasAdded: [],
    quotasRemoved: [],
    quotasChanged: [],
  };
  const curMembers = new Map(current.members.map((m) => [m.userId, m]));
  for (const m of newTeam.members) {
    const before = curMembers.get(m.userId);
    if (!before) diff.membersAdded.push(m);
    else if (before.name !== m.name || before.role !== m.role) {
      diff.membersChanged.push({ userId: m.userId, before, after: m });
    }
  }
  const newMemberIds = new Set(newTeam.members.map((m) => m.userId));
  for (const m of current.members) {
    if (!newMemberIds.has(m.userId)) diff.membersRemoved.push(m);
  }
  const curBots = new Map(current.sharedBots.map((b) => [b.botId, b]));
  const curQuotaByBot = new Map(currentQuotas.map((q) => [q.botId, q]));
  const newQuotaByBot = new Map(newQuotas.map((q) => [q.botId, q]));
  for (const b of newTeam.sharedBots) {
    const before = curBots.get(b.botId);
    if (!before) {
      diff.botsAdded.push({ botId: b.botId, sharedBy: b.sharedBy });
    } else if (before.sharedBy !== b.sharedBy) {
      diff.botsChanged.push({ botId: b.botId, changes: [`sharedBy: ${before.sharedBy || '—'} → ${b.sharedBy || '—'}`] });
    }
  }
  const newBotIds = new Set(newTeam.sharedBots.map((b) => b.botId));
  for (const b of current.sharedBots) {
    if (!newBotIds.has(b.botId)) diff.botsRemoved.push({ botId: b.botId, sharedBy: b.sharedBy });
  }
  for (const [botId, quota] of newQuotaByBot) {
    const before = curQuotaByBot.get(botId);
    if (!before) {
      diff.quotasAdded.push(quota);
    } else {
      const changes = quotaChanges(before, quota);
      if (changes.length > 0) diff.quotasChanged.push({ botId, changes });
    }
  }
  for (const [botId, quota] of curQuotaByBot) {
    if (!newQuotaByBot.has(botId)) diff.quotasRemoved.push(quota);
  }
  diff.changed =
    diff.membersAdded.length > 0 ||
    diff.membersRemoved.length > 0 ||
    diff.membersChanged.length > 0 ||
    diff.botsAdded.length > 0 ||
    diff.botsRemoved.length > 0 ||
    diff.botsChanged.length > 0 ||
    diff.quotasAdded.length > 0 ||
    diff.quotasRemoved.length > 0 ||
    diff.quotasChanged.length > 0;
  return diff;
}

/** Parse team YAML rồi diff với team hiện có (không ghi gì). */
export function diffTeamYaml(text: string, dataDir: string): TeamYamlDiff {
  const doc = parseTeamYaml(text);
  const team = teamYamlToConfig(doc);
  const quotas = doc.bots.filter((b) => b.computer).map((b) => b.computer as BotComputerQuota);
  return diffTeamConfig(team, quotas, dataDir);
}

/** Đọc file team (YAML hoặc JSON) và apply — CLI dùng hàm này. */
export function applyTeamFile(filePath: string, dataDir: string, options?: { dryRun?: boolean }): TeamYamlApplyResult {
  const text = fs.readFileSync(filePath, 'utf8');
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return applyTeamYaml(text, dataDir, options);
  }
  // JSON: giữ hành vi cũ (validateTeamConfig + save), quota = 0.
  const team = validateTeamConfig(JSON.parse(text) as unknown);
  if (!options?.dryRun) saveTeamConfig(dataDir, team);
  return { dryRun: options?.dryRun ?? false, team, computerQuotas: 0, teamPath: path.join(dataDir, 'team.json') };
}
