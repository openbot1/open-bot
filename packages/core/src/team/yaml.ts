/**
 * Team YAML (v1.06, Đội T3) — định nghĩa team bots bằng file YAML.
 *
 * Học ý tưởng "team = file khai báo" của OpenMausBot (team bots khai
 * báo trong một file, apply là tạo/cập nhật bot): một file YAML mô tả
 * team (tên + danh sách bot: tên, model, provider/CLI, computer,
 * tools cho phép), `team apply` tạo/cập nhật các bot đó trong
 * `<dataDir>/bots.json`, `team export` xuất team hiện tại ra YAML.
 *
 * Ví dụ:
 * ```yaml
 * team:
 *   name: "Đội hỗ trợ"
 *   description: "Bot chăm sóc khách hàng"
 *   bots:
 *     - id: helper
 *       name: "Trợ lý"
 *       model: "claude-sonnet-4-5"
 *       provider: claude-code
 *       computer: local
 *       tools: [read_file, shell_exec]
 * ```
 *
 * Parser là YAML-subset tự viết (không thêm dependency `yaml`):
 * chỉ hỗ trợ map lồng nhau, list map/scalar, flow list `[a, b]`,
 * scalar plain/quoted, comment `#`, `---` đầu file. Đủ cho file
 * khai báo team, và mọi lỗi đều báo SỐ DÒNG cụ thể (không "YAML
 * không hợp lệ" chung chung). File dùng cú pháp YAML ngoài subset
 * (anchor, multi-doc, block scalar `|`) bị từ chối với dòng rõ ràng
 * thay vì parse sai lặng lẽ.
 *
 * Validate kỹ trước khi ghi: tên team bắt buộc, id bot duy nhất +
 * đúng mẫu, provider phải nằm trong danh sách provider đã biết
 * (API provider + CLI kind + driver đã đăng ký — truyền vào qua
 * opts, mặc định chỉ kiểm tra mẫu), model không rỗng, tools (nếu
 * có) phải là tên tool hợp lệ. Lỗi validate nào cũng kèm số dòng.
 *
 * `computer`: 'local' | 'vm' | 'own' — nơi bot chạy (theo mẫu
 * OpenMausBot: cloud Linux desktop / Local VM / own computer).
 * open-bot hiện chỉ chạy local nên 'vm'/'own' được ghi nhận vào
 * snapshot để dùng sau, không chặn apply.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeDurableFileSync } from '../vault/durableFile';
import type { BotConfig } from '../types';
import type { CreateBotProviderConfig } from '../coordinator/types';

export const TEAM_YAML_FILE = 'team-bots.yaml';
export const TEAM_BOTS_JSON_FILE = 'bots.json';

/** Nơi bot chạy (theo mẫu OpenMausBot). */
export type TeamBotComputer = 'local' | 'vm' | 'own';
export const TEAM_BOT_COMPUTERS: readonly TeamBotComputer[] = ['local', 'vm', 'own'];

/** Một bot trong file team YAML. */
export interface TeamYamlBot {
  id: string;
  name: string;
  model: string;
  /** Provider id (vd 'claude-code', 'gemini', 'openai', 'ollama') hoặc CLI kind. */
  provider: string;
  computer: TeamBotComputer;
  /** Tool được phép (tên tool trong registry); rỗng = cho phép hết. */
  tools: string[];
  /** System prompt (không bắt buộc). */
  prompt?: string;
}

/** Nội dung file team YAML. */
export interface TeamYamlDoc {
  name: string;
  description?: string;
  bots: TeamYamlBot[];
}

/** Lỗi parse/validate kèm số dòng trong file YAML. */
export class TeamYamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(line > 0 ? `Dòng ${line}: ${message}` : message);
    this.name = 'TeamYamlError';
    this.line = line;
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOOL_RE = /^[a-z][a-z0-9_]*$/;
const PROVIDER_RE = /^[a-z][a-z0-9-]*$/;

/** Provider API + CLI mà open-bot biết (dùng khi không truyền danh sách riêng). */
export const KNOWN_TEAM_PROVIDERS: readonly string[] = [
  'mock',
  'grok',
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'openai-compatible',
  'claude-code',
  'codex',
  'grok-cli',
  'opencode',
  'gemini-cli',
  'cursor-cli',
  'aider',
  'continue-cli',
  'copilot-cli',
  'amazon-q',
  'windsurf',
  'kiro-cli',
  'custom-acp',
];

/** Một dòng YAML sau khi tách indent/comment. */
interface YamlLine {
  indent: number;
  content: string;
  lineNo: number;
}

function stripComment(line: string): string {
  // `#` trong chuỗi quoted không phải comment — quét có nhớ trạng thái quote.
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function splitLines(text: string): YamlLine[] {
  const out: YamlLine[] = [];
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const lineNo = i + 1;
    const noComment = stripComment(raw[i] ?? '');
    if (noComment.trim() === '') continue;
    if (noComment.trim() === '---' || noComment.trim() === '...') continue;
    const indent = noComment.length - noComment.trimStart().length;
    if (noComment.includes('\t')) {
      throw new TeamYamlError('không dùng tab để thụt dòng trong YAML (chỉ dùng khoảng trắng).', lineNo);
    }
    out.push({ indent, content: noComment.trim(), lineNo });
  }
  return out;
}

/** Parse một scalar: quoted, flow list, hoặc plain. */
function parseScalar(raw: string, lineNo: number): unknown {
  const text = raw.trim();
  if (text === '') throw new TeamYamlError('giá trị trống — cần ghi giá trị hoặc bỏ key này.', lineNo);
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) throw new TeamYamlError(`chuỗi "..." chưa đóng ngoặc: ${text}`, lineNo);
    try {
      return JSON.parse(text);
    } catch {
      throw new TeamYamlError(`chuỗi "..." không hợp lệ: ${text}`, lineNo);
    }
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) throw new TeamYamlError(`chuỗi '...' chưa đóng ngoặc: ${text}`, lineNo);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new TeamYamlError(`danh sách [...] chưa đóng ngoặc: ${text}`, lineNo);
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => {
      const item = parseScalar(part.trim(), lineNo);
      if (typeof item !== 'string') throw new TeamYamlError('danh sách chỉ chứa chuỗi.', lineNo);
      return item;
    });
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith('&') || text.startsWith('*') || text.startsWith('|') || text.startsWith('>') || text.startsWith('!')) {
    throw new TeamYamlError(`cú pháp YAML này chưa được hỗ trợ (anchor/alias/block scalar/tag): ${text}`, lineNo);
  }
  if (text.includes(': ')) throw new TeamYamlError(`giá trị chứa ": " — cần đặt trong ngoặc kép: "${text}"`, lineNo);
  return text;
}

type YamlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

/**
 * Parser đệ quy theo indent. Trả về giá trị + map đường dẫn → số
 * dòng (để validate báo lỗi đúng dòng, vd "bots[1].model").
 */
export function parseTeamYamlSubset(
  text: string,
): { value: YamlValue; lines: Map<string, number> } {
  const lines = splitLines(text);
  const lineOf = new Map<string, number>();
  if (lines.length === 0) throw new TeamYamlError('file YAML trống.', 0);
  let pos = 0;

  function parseBlock(indent: number, path: string): YamlValue {
    const first = lines[pos];
    if (!first) return {};
    if (first.indent < indent) return {};
    if (first.indent > indent) {
      throw new TeamYamlError(`thụt dòng không đúng (thừa khoảng trắng).`, first.lineNo);
    }
    if (first.content.startsWith('- ') || first.content === '-') {
      return parseSequence(indent, path);
    }
    return parseMapping(indent, path);
  }

  function parseMapping(indent: number, path: string): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (pos < lines.length) {
      const line = lines[pos] as YamlLine;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new TeamYamlError('thụt dòng không đúng trong map.', line.lineNo);
      if (line.content.startsWith('- ') || line.content === '-') break;
      const colon = findKeyColon(line.content);
      if (colon === -1) throw new TeamYamlError(`dòng này phải có dạng "key: value": ${line.content}`, line.lineNo);
      const key = line.content.slice(0, colon).trim();
      if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new TeamYamlError(`tên key không hợp lệ: "${key}"`, line.lineNo);
      if (key in obj) throw new TeamYamlError(`key "${key}" bị trùng.`, line.lineNo);
      const childPath = path ? `${path}.${key}` : key;
      lineOf.set(childPath, line.lineNo);
      const rest = line.content.slice(colon + 1).trim();
      pos += 1;
      if (rest !== '') {
        obj[key] = parseScalar(rest, line.lineNo);
      } else {
        const next = lines[pos];
        if (!next || next.indent <= indent) {
          obj[key] = null;
        } else {
          obj[key] = parseBlock(next.indent, childPath);
        }
      }
    }
    return obj;
  }

  function parseSequence(indent: number, path: string): unknown[] {
    const arr: unknown[] = [];
    while (pos < lines.length) {
      const line = lines[pos] as YamlLine;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new TeamYamlError('thụt dòng không đúng trong danh sách.', line.lineNo);
      if (!(line.content.startsWith('- ') || line.content === '-')) break;
      const itemPath = `${path}[${arr.length}]`;
      lineOf.set(itemPath, line.lineNo);
      const rest = line.content === '-' ? '' : line.content.slice(2).trim();
      if (rest === '') {
        pos += 1;
        const next = lines[pos];
        if (!next || next.indent <= indent) {
          arr.push(null);
        } else {
          arr.push(parseBlock(next.indent, itemPath));
        }
        continue;
      }
      const colon = findKeyColon(rest);
      if (colon === -1) {
        // Item scalar: `- tên`.
        arr.push(parseScalar(rest, line.lineNo));
        pos += 1;
        continue;
      }
      // Item là map bắt đầu ngay trên dòng `- key: value`: viết lại
      // thành dòng map giả với indent = indent + 2 rồi parse như map.
      const rewritten: YamlLine = { indent: indent + 2, content: rest, lineNo: line.lineNo };
      lines.splice(pos, 1, rewritten);
      arr.push(parseMapping(indent + 2, itemPath));
    }
    return arr;
  }

  const value = parseBlock(lines[0]?.indent ?? 0, '');
  if (pos < lines.length) {
    const leftover = lines[pos] as YamlLine;
    throw new TeamYamlError(`dòng thừa không parse được: ${leftover.content}`, leftover.lineNo);
  }
  return { value, lines: lineOf };
}

/** Tìm dấu `:` phân tách key — bỏ qua `:` trong chuỗi quoted và trong URL. */
function findKeyColon(content: string): number {
  let quote: string | null = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i] ?? '';
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i === content.length - 1 || content[i + 1] === ' ')) return i;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string, line: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TeamYamlError(`"${field}" phải là chuỗi không rỗng.`, line);
  }
  return value.trim();
}

/** Validate doc đã parse; lỗi nào cũng kèm số dòng. */
export function validateTeamYamlDoc(
  doc: unknown,
  lines: Map<string, number>,
  opts: { knownProviders?: readonly string[]; knownTools?: readonly string[] } = {},
): TeamYamlDoc {
  const line = (p: string): number => lines.get(p) ?? 0;
  if (!isRecord(doc) || !isRecord(doc['team'])) {
    throw new TeamYamlError('file phải có khối "team:" ở cấp cao nhất.', line('team'));
  }
  const team = doc['team'] as Record<string, unknown>;
  // Key thiếu thì không có dòng riêng — báo dòng của khối team:.
  const name = asString(team['name'], 'team.name', line('team.name') || line('team'));
  if (name.length > 100) throw new TeamYamlError('"team.name" tối đa 100 ký tự.', line('team.name'));
  let description: string | undefined;
  if (team['description'] !== undefined && team['description'] !== null) {
    description = asString(team['description'], 'team.description', line('team.description'));
  }
  const botsRaw = team['bots'];
  if (botsRaw !== undefined && !Array.isArray(botsRaw)) {
    throw new TeamYamlError('"team.bots" phải là danh sách.', line('team.bots'));
  }
  const bots: TeamYamlBot[] = [];
  const seenIds = new Set<string>();
  const knownProviders = opts.knownProviders ?? KNOWN_TEAM_PROVIDERS;
  const knownTools = opts.knownTools;
  for (let i = 0; i < (botsRaw ?? []).length; i++) {
    const base = `team.bots[${i}]`;
    const raw = (botsRaw as unknown[])[i];
    if (!isRecord(raw)) throw new TeamYamlError(`bot thứ ${i + 1} phải là một map (dạng "- id: ...").`, line(base));
    const id = asString(raw['id'], `${base}.id`, line(`${base}.id`));
    if (!ID_RE.test(id)) throw new TeamYamlError(`bot id "${id}" không hợp lệ — chỉ dùng chữ/số/_/- , bắt đầu bằng chữ hoặc số.`, line(`${base}.id`));
    if (seenIds.has(id)) throw new TeamYamlError(`bot id "${id}" bị trùng (đã có ở bot trước).`, line(`${base}.id`));
    seenIds.add(id);
    const botName = asString(raw['name'], `${base}.name`, line(`${base}.name`));
    const model = asString(raw['model'], `${base}.model`, line(`${base}.model`));
    const provider = asString(raw['provider'], `${base}.provider`, line(`${base}.provider`));
    if (!PROVIDER_RE.test(provider)) throw new TeamYamlError(`provider "${provider}" không hợp lệ.`, line(`${base}.provider`));
    if (!knownProviders.includes(provider)) {
      throw new TeamYamlError(`provider "${provider}" chưa biết — provider hợp lệ: ${knownProviders.join(', ')}.`, line(`${base}.provider`));
    }
    let computer: TeamBotComputer = 'local';
    if (raw['computer'] !== undefined && raw['computer'] !== null) {
      const c = asString(raw['computer'], `${base}.computer`, line(`${base}.computer`));
      if (!(TEAM_BOT_COMPUTERS as readonly string[]).includes(c)) {
        throw new TeamYamlError(`computer "${c}" không hợp lệ — chỉ nhận: ${TEAM_BOT_COMPUTERS.join(', ')}.`, line(`${base}.computer`));
      }
      computer = c as TeamBotComputer;
    }
    let tools: string[] = [];
    if (raw['tools'] !== undefined && raw['tools'] !== null) {
      if (!Array.isArray(raw['tools'])) throw new TeamYamlError(`"${base}.tools" phải là danh sách tên tool.`, line(`${base}.tools`));
      for (const tool of raw['tools'] as unknown[]) {
        if (typeof tool !== 'string' || !TOOL_RE.test(tool)) {
          throw new TeamYamlError(`tên tool không hợp lệ: ${JSON.stringify(tool)} — chỉ dùng chữ thường/số/_ .`, line(`${base}.tools`));
        }
        if (knownTools && !knownTools.includes(tool)) {
          throw new TeamYamlError(`tool "${tool}" không có trong registry — kiểm tra lại tên tool.`, line(`${base}.tools`));
        }
        if (!tools.includes(tool)) tools.push(tool);
      }
    }
    let prompt: string | undefined;
    if (raw['prompt'] !== undefined && raw['prompt'] !== null) {
      prompt = asString(raw['prompt'], `${base}.prompt`, line(`${base}.prompt`));
    }
    bots.push({ id, name: botName, model, provider, computer, tools, ...(prompt ? { prompt } : {}) });
  }
  return { name, ...(description ? { description } : {}), bots };
}

/** Parse + validate một file team YAML thành TeamYamlDoc. */
export function parseTeamYaml(
  text: string,
  opts: { knownProviders?: readonly string[]; knownTools?: readonly string[] } = {},
): TeamYamlDoc {
  const { value, lines } = parseTeamYamlSubset(text);
  return validateTeamYamlDoc(value, lines, opts);
}

function yamlQuote(value: string): string {
  if (/^[A-Za-z0-9 _\-./:]+$/.test(value) && !value.includes(': ')) return value;
  return JSON.stringify(value);
}

/** Serialize TeamYamlDoc ra YAML (định dạng mà parseTeamYaml đọc lại được). */
export function serializeTeamYaml(doc: TeamYamlDoc): string {
  const out: string[] = [];
  out.push('team:');
  out.push(`  name: ${yamlQuote(doc.name)}`);
  if (doc.description) out.push(`  description: ${yamlQuote(doc.description)}`);
  if (doc.bots.length === 0) {
    out.push('  bots: []');
  } else {
    out.push('  bots:');
    for (const bot of doc.bots) {
      out.push(`    - id: ${yamlQuote(bot.id)}`);
      out.push(`      name: ${yamlQuote(bot.name)}`);
      out.push(`      model: ${yamlQuote(bot.model)}`);
      out.push(`      provider: ${yamlQuote(bot.provider)}`);
      out.push(`      computer: ${bot.computer}`);
      if (bot.tools.length > 0) {
        out.push(`      tools: [${bot.tools.join(', ')}]`);
      }
      if (bot.prompt) out.push(`      prompt: ${yamlQuote(bot.prompt)}`);
    }
  }
  return out.join('\n') + '\n';
}

export interface TeamYamlApplyResult {
  teamName: string;
  /** Số bot mới tạo. */
  created: number;
  /** Số bot đã có và được cập nhật. */
  updated: number;
  /** Id các bot đã áp dụng (theo thứ tự trong file). */
  botIds: string[];
  /** Đường dẫn bots.json đã ghi. */
  botsPath: string;
  /** Đường dẫn snapshot YAML đã ghi. */
  yamlPath: string;
}

interface BotsFileEntry {
  bot: BotConfig;
  provider: CreateBotProviderConfig;
}

function loadBotsFile(dataDir: string): BotsFileEntry[] {
  const file = path.join(dataDir, TEAM_BOTS_JSON_FILE);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`bots.json hỏng (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`bots.json sai định dạng: cần mảng [{bot, provider}].`);
  return parsed as BotsFileEntry[];
}

function saveBotsFile(dataDir: string, entries: BotsFileEntry[]): string {
  const file = path.join(dataDir, TEAM_BOTS_JSON_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  writeDurableFileSync(file, JSON.stringify(entries, null, 2) + '\n');
  return file;
}

/**
 * Áp dụng file team YAML: tạo mới bot chưa có, cập nhật bot đã có
 * (khớp theo id). Bot trong bots.json mà file YAML không nhắc tới
 * được GIỮ NGUYÊN (apply không xoá bot) — muốn xoá thì xoá trong
 * app/CLI riêng. Ghi đè snapshot YAML vào `<dataDir>/team-bots.yaml`
 * để `team export` đọc lại được computer/tools.
 */
export function applyTeamYaml(
  dataDir: string,
  text: string,
  opts: { knownProviders?: readonly string[]; knownTools?: readonly string[] } = {},
): TeamYamlApplyResult {
  const doc = parseTeamYaml(text, opts);
  const entries = loadBotsFile(dataDir);
  const byId = new Map(entries.map((e) => [e.bot.id, e]));
  let created = 0;
  let updated = 0;
  for (const bot of doc.bots) {
    const botConfig: BotConfig = {
      id: bot.id,
      name: bot.name,
      providerId: bot.provider,
      model: bot.model,
      systemPrompt: bot.prompt ?? '',
      workspaceDir: path.join(dataDir, 'workspaces', bot.id),
      autoApprove: false,
    };
    const provider: CreateBotProviderConfig = { id: bot.provider, label: bot.provider, defaultModel: bot.model };
    const existing = byId.get(bot.id);
    if (existing) {
      existing.bot = { ...existing.bot, ...botConfig, workspaceDir: existing.bot.workspaceDir || botConfig.workspaceDir };
      existing.provider = provider;
      updated += 1;
    } else {
      const entry: BotsFileEntry = { bot: botConfig, provider };
      entries.push(entry);
      byId.set(bot.id, entry);
      created += 1;
    }
  }
  const botsPath = saveBotsFile(dataDir, entries);
  const yamlPath = path.join(dataDir, TEAM_YAML_FILE);
  writeDurableFileSync(yamlPath, serializeTeamYaml(doc));
  return { teamName: doc.name, created, updated, botIds: doc.bots.map((b) => b.id), botsPath, yamlPath };
}

/**
 * Xuất team hiện tại ra YAML: đọc bots.json (+ snapshot team-bots.yaml
 * để lấy lại computer/tools/description khi còn). Không có bot nào
 * thì xuất team rỗng với tên mặc định.
 */
export function exportTeamYaml(dataDir: string, teamName = 'Team của tôi'): string {
  const entries = loadBotsFile(dataDir);
  let snapshot: TeamYamlDoc | null = null;
  const snapshotPath = path.join(dataDir, TEAM_YAML_FILE);
  if (fs.existsSync(snapshotPath)) {
    try {
      snapshot = parseTeamYaml(fs.readFileSync(snapshotPath, 'utf8'));
    } catch {
      snapshot = null; // snapshot hỏng thì export từ bots.json, không crash
    }
  }
  const snapById = new Map((snapshot?.bots ?? []).map((b) => [b.id, b]));
  const doc: TeamYamlDoc = {
    name: snapshot?.name ?? teamName,
    ...(snapshot?.description ? { description: snapshot.description } : {}),
    bots: entries.map((e) => {
      const snap = snapById.get(e.bot.id);
      return {
        id: e.bot.id,
        name: e.bot.name,
        model: e.bot.model,
        provider: e.bot.providerId,
        computer: snap?.computer ?? 'local',
        tools: snap?.tools ?? [],
        ...(e.bot.systemPrompt ? { prompt: e.bot.systemPrompt } : {}),
      };
    }),
  };
  return serializeTeamYaml(doc);
}
