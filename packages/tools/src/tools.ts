/**
 * Tool implementations for @open-bot/tools.
 *
 * Contract with @open-bot/core (imported as types only — erased at runtime):
 *   Tool { definition: ToolDefinition; needsApproval: boolean;
 *          execute(args, ctx): Promise<string> }
 * The core agent handles approval from `needsApproval`; tools only execute
 * safely and return a string (truncated to at most 20_000 chars).
 *
 * Safety rules:
 *  - Every file/shell operation goes through the sandbox (resolveWithin /
 *    runShell). There is no path out of ctx.workspaceDir.
 *  - No user data leaves the machine except through web_search / web_fetch /
 *    http_get, and only to the exact URL the agent/user asked for.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '@open-bot/core';
import type { EgressPolicy } from '@open-bot/core/dist/egress/policy';
import {
  assertCommandAllowed,
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  resolveWithin,
  runShell,
  safeEnv,
} from './sandbox';
import { shellQuote } from './shellQuote';
import { fetchPublic } from './ssrf';
import type { ShellDaemon } from './daemon/types';
import { createToolBlobTools, truncateWithBlob } from './blobStore';
import { MAX_TOOL_RESULT_CHARS, truncateText } from './truncate';
import {
  extractOfficeText,
  isOfficeExtension,
  MAX_OFFICE_READ_BYTES,
} from './officeDocs';
// --- v0.89 (worker F4): data / http / text / office-write tools ---
import { DATA_TOOLS } from './dataTools';
import { createHttpTools, HTTP_TOOLS } from './httpTools';
import { OFFICE_WRITE_TOOLS } from './officeWriteTools';
import { TEXT_TOOLS } from './textTools';
// --- v0.98 (T6): git_log KHÔNG gộp vào ALL_TOOLS — v0.97's
// gitWorkflowTools đã đăng ký `git_log` (xem ./gitLog.ts); đăng ký cả
// hai sẽ trùng tên trong registry. Các filter until/grep/stat của T6
// đã port sang gitWorkflowTools.git_log.
// --- v0.95 (Team D1): internet data (clean fetch for web_fetch) ---
import { createInternetDataTools, extractReadableText, INTERNET_DATA_TOOLS } from './internetData';
import type { WatchChangeEvent } from './internetData';
// --- v1.02 (rescue port of v0.99/v1.00): context/durable/orchestra/gateway/dream/substrate/ACP tools ---
import { RESCUE_V102_TOOLS } from './rescueV102Tools';
// --- v1.03 (Đội T1): harness engine v2 — CodeAct + time-travel/fork/stuck/condenser tools ---
import { HARNESS_V103_TOOLS } from './harnessV103Tools';
// --- v1.07 (Đội T2): harness v3 — delegate + budget meter + LLM profile tools ---
import { HARNESS_V107_TOOLS } from './harnessV107Tools';
// --- v1.08 (Đội T3): harness v4 — EventLog (6) + CodeAct run/loop (2) + dependency sweep (4) = 12 ---
import { HARNESS_V4_TOOLS } from './harnessV4Tools';
// --- v1.03 (Đội T4): workspace abstraction v3 (local/container, quota, snapshot) ---
import { WORKSPACE_TOOLS } from './workspaceTools';
// --- v1.03 (Team T6): fleet overview/scheduling + marketplace v3 tools ---
import { FLEET_V103_TOOLS, createFleetV103Tools } from './fleetV103Tools';
// --- v1.05 (Đội T3): OpenMausBot parity — doctor, team YAML, model
// refresh, per-bot computer v2, headless status (8 tools) ---
import { OPENMAUSBOT_V105_TOOLS, createOpenmausbotV105Tools } from './openmausbotV105Tools';
// --- v1.05 (Team T6): eval v3 (memory eval offline) + fleet v4
// (priority scheduling, health + auto-restart, policy v4) tools ---
import { EVAL_FLEET_V105_TOOLS, createEvalFleetV105Tools } from './evalFleetV105Tools';
// --- v1.06 (Đội T3): doctor + team YAML + driver registry + engine picker ---
import { DOCTOR_TOOLS } from './doctorTools';
import { TEAM_YAML_TOOLS } from './teamYamlTools';
import { DRIVER_TOOLS } from './driverTools';
import { ENGINE_PICKER_TOOLS } from './enginePickerTools';
import { PLATFORM_V4_TOOLS, createPlatformV4Tools } from './platformV4Tools';
// --- v1.07 (Đội T1): memory v8 tools (sleep policy + nén block, fused
// retrieval local, provenance, review chống poisoning, fleet sync,
// xóa GDPR) — 12 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V8_TOOLS, createMemoryV8Tools } from './memoryV8Tools';
// --- v1.08 (Đội T1): memory v9 tools (sleep daemon nền, git-backed
// versioning, shared-block registry) — 14 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V9_TOOLS, createMemoryV9Tools, getMemoryV9Agent } from './memoryV9Tools';
import { MEMORY_V10_TOOLS, createMemoryV10Tools } from './memoryV10Tools';
// --- v1.11 (Doi T1): memory v11 tools (block kinds + <memory_blocks>,
// insert/patch, unified block_history, shared supervisor, sleep agent)
// — 9 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V11_TOOLS, createMemoryV11Tools } from './memoryV11Tools';
// --- v1.09 (Đội T2): memory v9 kiểu Letta tools (core memory tự sửa
// qua tool, recall, archival, entity bền vững, sleep pass/proposals)
// — 23 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V9_LETTA_TOOLS, createMemoryV9LettaTools } from './memoryV9LettaTools';
// --- v1.08 (Đội T2): coding agent v2 — repo map PageRank symbol-level,
// architect mode (planner/editor tách riêng), git-first (commit/diff/
// revert/squash) — 10 tools, placeholder trong ALL_TOOLS ---
import { CODING_V2_TOOLS, createCodingV2Tools } from './codingV2Tools';
// --- v1.10 (Đội T4): coding agent v3 — repo map call edges + module graph +
// token-budget map, manager/explorer/worker, eval harness Terminal-Bench,
// router model local — 12 tools, placeholder trong ALL_TOOLS ---
import { CODING_V3_TOOLS, createCodingV3Tools } from './codingV3Tools';
// --- v1.11 (Đội T4): coding agent v4 — repo map PageRank v2 (4) +
// sub-agent visualizer (4) + ACP model switching (3) + coding profiles (3) = 14 --
import { CODING_V4_TOOLS, createCodingV4Tools } from './codingV4Tools';
// --- v1.07 (Đội T4): skills & plugins — directory skills (2) + plugin bundle (3) + hooks config (1) + inline secret (2) = 8 ---
import {
  createSkillsPluginsV107Tools,
  SKILLS_PLUGINS_V107_TOOLS,
} from './skillsPluginsV107Tools';
import type { SkillsPluginsV107ToolOptions } from './skillsPluginsV107Tools';
// --- v1.07 (Đội T6): fleet v4 teams — Agent Teams + worktree isolation +
// router context window + prompt-cache theo hash (5 tools) ---
import { FLEET_V4_TEAMS_TOOLS, createFleetV4TeamsTools } from './fleetV4TeamsTools';
import { TEAM_V109_TOOLS, createAgentTeamsV109Tools } from './agentTeamsV109Tools';
import { TEAM_V2_TOOLS, createAgentTeamsV2Tools } from './agentTeamsV2Tools';
import { TEAM_V3_TOOLS, createAgentTeamsV3Tools } from './agentTeamsV3Tools';
// --- v1.08 (Đội T4): providers v2 — Composio v2 (8) + provider health (5) +
// OpenRouter/Fireworks models + info (4) = 17 tools ---
import {
  createProvidersV108Tools,
  PROVIDERS_V108_TOOLS,
} from './providersV108Tools';
import type { ProvidersV108ToolOptions } from './providersV108Tools';
// --- v1.08 (Đội T6): fleet v5 — campaign đa repo + budget v2 +
// health dashboard v5 (10 tools) ---
import { FLEET_V5_TOOLS, createFleetV5Tools } from './fleetV5Tools';
// --- v1.09 (Đội T6): fleet v6 — scheduler (cron/interval/event +
// timeslot + priority queue) + quota nhóm + health (restart backoff +
// incident log) (10 tools) ---
import { FLEET_V6_TOOLS, createFleetV6Tools } from './fleetV6Tools';
// --- v1.10 (Đội T6): fleet campaign v2 (canary → staged → full +
// rollback + report + pause/resume/cancel/clone/plan) + Composio mock toolkit (2) + Cerebras models (1)
// (14 tools) ---
import { FLEET_V7_TOOLS, createFleetV7Tools } from './fleetV7Tools';
// --- v1.11 (Đội T2): Harbor eval + rollout JSONL + Agent Profiles
// (9 tools) — placeholder trong ALL_TOOLS ---
import { EVAL_V111_TOOLS, createEvalV111Tools } from './evalV111Tools';
import type { EvalV111ToolOptions } from './evalV111Tools';
// --- v1.11 (Đội T5): voice v10 — realtime v2 + VAD v10 + noise +
// bot voice presets + AG-UI voice v3 (10 tools) ---
import { VOICE_V10_TOOLS, createVoiceV10Tools } from './voiceV10Tools';
import { FLEET_V8_TOOLS, createFleetV8Tools } from './fleetV8Tools';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri
// 20.000) — re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };
const MAX_READ_BYTES = 100_000;
const MAX_LIST_ITEMS = 200;
const FETCH_TIMEOUT_MS = 20_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * v0.41 (P0-3, `TruncatedToolCall` kiểu Grok): kết quả dài hơn ngưỡng
 * được lưu nguyên văn vào blob store và chỉ trả preview kèm `blob_id`
 * + `original_size_bytes` (xem blobStore.ts) — agent lấy phần đầy đủ
 * bằng `tool_blob_fetch`. Khi không có workspaceDir (hoặc ghi blob
 * lỗi) thì rơi về cắt cứng kiểu cũ — footer cũ giữ nguyên chuỗi con
 * `truncated to <N> chars` để tương thích ngược.
 */
function truncate(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS, workspaceDir?: string): string {
  if (workspaceDir) return truncateWithBlob(text, workspaceDir, maxChars);
  // Cat cung kieu cu — nay dung helper dung chung (./truncate).
  return truncateText(text, maxChars);
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

/** fetch() with a hard timeout. Throws on timeout / network error. */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http:// and https:// URLs are allowed, got "${url.protocol}"`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

const readFileTool: Tool = {
  definition: {
    name: 'read_file',
    description:
      'Read a file inside the workspace. Plain text files return their contents (max 100KB). PDF, DOCX and XLSX files return extracted text (max 5MB): PDF text per page (scanned image PDFs have no text layer and cannot be read — no OCR), DOCX text with headings and tables, XLSX text per sheet with sheet names. Encrypted or corrupted files return an error.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const fullPath = resolveWithin(ctx.workspaceDir, relPath);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return errorResult(`Not a file: "${relPath}"`);
      const ext = path.extname(relPath).toLowerCase();
      if (isOfficeExtension(ext)) {
        // Office documents are binary containers — never read as UTF-8.
        // They get a larger byte cap than plain text (5 MB vs 100 KB:
        // the formats are compressed, so 100 KB would reject most real
        // documents); the extracted text is still truncated to
        // MAX_TOOL_RESULT_CHARS exactly like plain text (see officeDocs).
        if (stat.size > MAX_OFFICE_READ_BYTES) {
          return errorResult(
            `File is ${stat.size} bytes, over the ${MAX_OFFICE_READ_BYTES} byte read limit for office documents: "${relPath}"`,
          );
        }
        const text = await extractOfficeText(ext, fs.readFileSync(fullPath));
        return truncate(text, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
      }
      if (stat.size > MAX_READ_BYTES) {
        return errorResult(
          `File is ${stat.size} bytes, over the ${MAX_READ_BYTES} byte read limit: "${relPath}"`,
        );
      }
      return truncate(fs.readFileSync(fullPath, 'utf8'), MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const writeFileTool: Tool = {
  definition: {
    name: 'write_file',
    description:
      'Write (create or overwrite) a text file inside the workspace. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
        content: { type: 'string', description: 'Full text content to write.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const relPath = getStringArg(args, 'path');
      const content = getStringArg(args, 'content');
      const fullPath = resolveWithin(ctx.workspaceDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to "${relPath}".`;
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const listFilesTool: Tool = {
  definition: {
    name: 'list_files',
    description:
      'List entries in a directory inside the workspace (max 200 items), marking files vs directories with sizes.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list, relative to the workspace root. Defaults to the workspace root.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const relPath = args['path'] === undefined ? '.' : getStringArg(args, 'path', false);
      const fullPath = resolveWithin(ctx.workspaceDir, relPath);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) return errorResult(`Not a directory: "${relPath}"`);
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const shown = entries.slice(0, MAX_LIST_ITEMS);
      const lines = shown.map((entry) => {
        if (entry.isDirectory()) return `DIR  ${entry.name}/`;
        let size = 0;
        try {
          size = fs.statSync(path.join(fullPath, entry.name)).size;
        } catch {
          size = 0;
        }
        return `FILE ${entry.name} (${size} bytes)`;
      });
      const note =
        entries.length > MAX_LIST_ITEMS
          ? `\n[... showing ${MAX_LIST_ITEMS} of ${entries.length} entries ...]`
          : '';
      return truncate(`Directory "${relPath}" — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}${note}`, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Shell tool
// ---------------------------------------------------------------------------

/**
 * Build the shell_exec tool.
 *
 * When `getDaemon` is given and returns a live daemon client, the command
 * runs in the local-exec-daemon child process (crash-isolated, killable);
 * otherwise it runs in-process via runShell (same sandbox rules either
 * way). The sandbox checks (denylist + cwd confinement) always run in
 * the tool FIRST — the daemon re-checks them per request as
 * defence-in-depth (v0.15/v0.16), using the `workspaceDir` passed here
 * (request workspaceDir > daemon workspaceDir > không giam).
 *
 * v0.55: `opts.getEgressPolicy` — resolver policy egress hiệu lực của
 * team hiện tại (coordinator truyền xuống, xem `ToolFactoryHost`).
 * Resolve lười mỗi lần chạy nên sửa team.json có hiệu lực ngay.
 *  - Đường in-process: resolver đi thẳng vào `runShell` (provider
 *    thắng policy module; `undefined` → fail-closed, `null` → tắt).
 *  - Đường daemon: policy đã resolve được mang theo từng request
 *    (`egressPolicy` — daemon ưu tiên policy request hơn policy chung
 *    của nó); resolver trả `undefined` thì không mang theo gì (daemon
 *    dùng policy của nó); `null` cũng không mang theo (daemon coi
 *    `null` là policy sai → BAD_REQUEST, còn `null` vốn chỉ dành cho
 *    test/caller cũ trên đường in-process).
 *
 * Output format is identical on both paths so the agent sees the same
 * shape: `exit code: N`, then `--- stdout ---` / `--- stderr ---`.
 */
export function createShellExecTool(
  getDaemon?: () => ShellDaemon | null,
  opts?: { getEgressPolicy?: () => EgressPolicy | null | undefined },
): Tool {
  return {
    definition: {
      name: 'shell_exec',
      description:
        'Run a shell command inside the workspace directory. Blocked: destructive commands (rm -rf /, mkfs, dd, shutdown, sudo, piping to a shell, ...). Timeout 60s.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const command = getStringArg(args, 'command');
        // Sandbox FIRST: denylist + cwd confinement, before anything
        // reaches the daemon (the daemon re-checks per request as
        // defence-in-depth, v0.15/v0.16).
        assertCommandAllowed(command);
        const cwd = resolveWithin(ctx.workspaceDir, ctx.workspaceDir);
        const daemon = getDaemon?.() ?? null;
        if (!daemon) {
          const result = await runShell(command, cwd, {
            workspaceDir: ctx.workspaceDir,
            signal: ctx.signal,
            // v0.55: policy egress của team hiện tại (resolve lười).
            getEgressPolicy: opts?.getEgressPolicy,
          });
          return formatShellResult(result.code, result.stdout, result.stderr, false, ctx.workspaceDir);
        }
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'powershell' : '/bin/sh';
        const shellArgs = isWindows ? ['-NoProfile', '-Command', command] : ['-c', command];
        const execId = randomUUID();
        let stdout = '';
        let stderr = '';
        const onAbort = (): void => {
          void daemon.kill(execId).catch(() => undefined);
        };
        if (ctx.signal) {
          if (ctx.signal.aborted) {
            await daemon.kill(execId).catch(() => undefined);
            return errorResult('Shell command aborted before it started.');
          }
          ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          // v0.55: policy egress của team hiện tại mang theo request —
          // daemon ưu tiên policy request hơn policy chung của nó.
          // Chỉ mang theo khi resolve ra policy thật (object); `undefined`
          // (không có policy) thì để daemon tự resolve/fail-closed theo
          // policy của nó, `null` (tắt) không có dạng hợp lệ trên đường
          // daemon nên cũng bỏ qua.
          const egressPolicy = opts?.getEgressPolicy?.();
          const result = await daemon.exec(
            {
              command: shell,
              args: shellArgs,
              cwd,
              // v0.16 (M1 đa bot): giam exec này theo đúng workspace của
              // bot gọi — daemon dùng chung cho nhiều bot nên mỗi
              // request phải mang theo workspaceDir của mình.
              workspaceDir: ctx.workspaceDir,
              // safeEnv() allowlist only: a shell child must never
              // inherit secrets from the parent process's env.
              env: { ...safeEnv() } as Record<string, string>,
              timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
              ...(egressPolicy ? { egressPolicy } : {}),
            },
            {
              onStdout: (chunk) => {
                if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
              },
              onStderr: (chunk) => {
                if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
              },
            },
            execId,
          );
          return formatShellResult(result.exitCode, stdout, stderr, result.timedOut, ctx.workspaceDir);
        } finally {
          ctx.signal?.removeEventListener('abort', onAbort);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

/** Shared output format for the shell tool (daemon path + in-process path). */
function formatShellResult(
  code: number | null,
  stdout: string,
  stderr: string,
  timedOut: boolean,
  workspaceDir?: string,
): string {
  const out: string[] = [
    `exit code: ${code === null ? 'null (timed out / killed)' : code}`,
  ];
  const stdoutText = stdout.length > MAX_OUTPUT_CHARS ? stdout.slice(0, MAX_OUTPUT_CHARS) : stdout;
  const stderrText = stderr.length > MAX_OUTPUT_CHARS ? stderr.slice(0, MAX_OUTPUT_CHARS) : stderr;
  if (stdoutText.trim()) out.push(`--- stdout ---\n${stdoutText}`);
  if (stderrText.trim()) out.push(`--- stderr ---\n${stderrText}`);
  if (timedOut) out.push(`[shell: killed after ${DEFAULT_SHELL_TIMEOUT_MS}ms timeout]`);
  return truncate(out.join('\n'), MAX_TOOL_RESULT_CHARS, workspaceDir);
}

/** No-daemon shell tool (in-process runShell). Kept for ALL_TOOLS. */
const shellExecTool: Tool = createShellExecTool();

// ---------------------------------------------------------------------------
// Web tools (no API key; only fetch the exact URL the agent/user asked for)
// ---------------------------------------------------------------------------


/** Parse DuckDuckGo HTML results (max 8). Returns [] when nothing parses. */
export function parseDuckDuckGoResults(html: string): Array<{ href: string; title: string; snippet: string }> {
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ href: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < 8) {
    let href = decodeHtmlEntities(m[1] ?? '');
    // DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<url-encoded target>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        // Keep the wrapped link.
      }
    }
    links.push({ href, title: stripHtml(m[2] ?? '') });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 8) {
    snippets.push(stripHtml(m[1] ?? ''));
  }
  return links.map((link, i) => ({ ...link, snippet: snippets[i] ?? '' }));
}

/**
 * Unwrap a Bing redirect link (`bing.com/ck/a?...&u=a1<target>`) to its
 * destination URL. Returns the original href when it is not such a link
 * or the target cannot be recovered.
 */
export function unwrapBingRedirect(href: string): string {
  try {
    const url = new URL(href);
    if (
      url.hostname.endsWith('bing.com') &&
      (url.pathname === '/ck/a' || url.pathname === '/aclick')
    ) {
      const u = url.searchParams.get('u');
      if (u) {
        const candidates = [
          u,
          u.replace(/^a1/, ''),
          decodeURIComponent(u),
          decodeURIComponent(u).replace(/^a1/, ''),
        ];
        for (const candidate of candidates) {
          if (/^https?:\/\//.test(candidate)) return candidate;
        }
        // Bing's newer redirect format: u=a1<base64url of the target URL>
        // (e.g. a1aHR0cHM6Ly9leGFtcGxlLmNvbS8...). Strip the "a1" prefix,
        // base64-decode (URL-safe alphabet, padding restored) and return
        // the decoded URL when it looks like one.
        const stripped = u.replace(/^a1/, '');
        if (/^[A-Za-z0-9_-]+={0,2}$/.test(stripped) && stripped.length >= 8) {
          try {
            const decoded = Buffer.from(
              stripped.replace(/-/g, '+').replace(/_/g, '/'),
              'base64',
            ).toString('utf-8');
            if (/^https?:\/\//.test(decoded)) return decoded;
          } catch {
            // Not valid base64 — keep the original href below.
          }
        }
      }
    }
  } catch {
    // Not a parseable URL — keep the original href.
  }
  return href;
}

/**
 * Fallback search via Bing HTML (no API key). Parses up to 8 results from
 * `<li class="b_algo"><h2><a href=...>title</a></h2><p>snippet</p>`.
 * Returns [] when Bing blocks the request or its layout changed.
 */
export async function searchBing(
  query: string,
): Promise<Array<{ href: string; title: string; snippet: string }>> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const re =
    /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  const out: Array<{ href: string; title: string; snippet: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 8) {
    const href = unwrapBingRedirect(decodeHtmlEntities(m[1] ?? '').trim());
    if (!href || href.startsWith('#')) continue;
    out.push({
      href,
      title: stripHtml(m[2] ?? '').trim(),
      snippet: stripHtml(m[3] ?? '').trim(),
    });
  }
  return out;
}

export function formatSearchResults(
  query: string,
  source: string,
  results: Array<{ href: string; title: string; snippet: string }>,
  label = 'Web search',
): string {
  const lines = results.map((r, i) => {
    const snippet = r.snippet ? `\n  ${r.snippet}` : '';
    return `${i + 1}. ${r.title}\n   ${r.href}${snippet}`;
  });
  return truncate(`${label} for "${query}" via ${source} — ${results.length} result(s):\n${lines.join('\n')}`);
}

/**
 * Shared web search (no API key): DuckDuckGo HTML first, Bing HTML
 * fallback. Returns null when neither engine yields usable results.
 * Used by `web_search` and by `x_search` (with a `site:x.com` prefix).
 */
export async function searchWeb(
  query: string,
): Promise<{ source: string; results: Array<{ href: string; title: string; snippet: string }> } | null> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (res.ok) {
      const results = parseDuckDuckGoResults(await res.text());
      if (results.length > 0) return { source: 'DuckDuckGo', results };
    }
  } catch {
    // Fall through to the Bing fallback below.
  }
  const bingResults = await searchBing(query);
  if (bingResults.length > 0) return { source: 'Bing', results: bingResults };
  return null;
}

const webSearchTool: Tool = {
  definition: {
    name: 'web_search',
    description:
      'Search the web via DuckDuckGo, falling back to Bing HTML if DuckDuckGo fails (no API key). Returns up to 8 results with title, URL and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args) {
    try {
      const query = getStringArg(args, 'query');
      const found = await searchWeb(query);
      if (!found) {
        return errorResult(
          'Web search failed: DuckDuckGo returned no usable results (blocked or layout changed) ' +
            'and the Bing fallback also returned nothing. Try again later or use web_fetch on a search URL directly.',
        );
      }
      return formatSearchResults(query, found.source, found.results);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  }

};

const webFetchTool: Tool = {
  definition: {
    name: 'web_fetch',
    description:
      'Fetch a web page (http/https only) and return its readable text with HTML tags removed (max 20,000 chars). Internal/private URLs (localhost, private LAN, cloud metadata) are blocked.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const url = assertHttpUrl(getStringArg(args, 'url'));
      // v0.15 (H3 audit): chặn SSRF — không GET service nội bộ (loopback /
      // private / link-local / metadata cloud), kể cả qua redirect.
      const res = await fetchPublic(url.toString(), {
        headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' },
      }, FETCH_TIMEOUT_MS);
      if (!res.ok) return errorResult(`GET ${url} failed with HTTP ${res.status}`);
      // v0.95 (Team D1): readable-text extraction — title + headings +
      // paragraphs, boilerplate (nav/header/footer/scripts) removed,
      // instead of the old flat tag strip.
      const text = extractReadableText(await res.text());
      return truncate(text, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const httpGetTool: Tool = {
  definition: {
    name: 'http_get',
    description:
      'GET JSON or text from any public API endpoint (http/https only). Returns the response body (max 20,000 chars). Internal/private URLs (localhost, private LAN, cloud metadata) are blocked.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL to GET.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      const url = assertHttpUrl(getStringArg(args, 'url'));
      // v0.15 (H3 audit): chặn SSRF — xem web_fetch.
      const res = await fetchPublic(url.toString(), {
        headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/json, text/*, */*' },
      }, FETCH_TIMEOUT_MS);
      if (!res.ok) return errorResult(`GET ${url} failed with HTTP ${res.status}`);
      return truncate(await res.text(), MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Git tools (read-only except git_commit, which needs approval)
// ---------------------------------------------------------------------------

async function runGit(gitArgs: string, ctx: ToolContext): Promise<string> {
  const result = await runShell(`git ${gitArgs}`, ctx.workspaceDir, {
    workspaceDir: ctx.workspaceDir,
    signal: ctx.signal,
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return errorResult(`git ${gitArgs.split(' ')[0]} failed (exit ${result.code}): ${detail}`);
  }
  return result.stdout;
}

const gitStatusTool: Tool = {
  definition: {
    name: 'git_status',
    description: 'Show `git status --porcelain` for the workspace repository.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  needsApproval: false,
  async execute(_args, ctx) {
    try {
      const out = await runGit('status --porcelain', ctx);
      if (out.startsWith('Error:')) return out;
      return truncate(out.trim() === '' ? '(working tree clean)' : out, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const gitDiffTool: Tool = {
  definition: {
    name: 'git_diff',
    description: 'Show `git diff` for the workspace (optionally for one file). Max 10,000 chars.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional single file path inside the workspace.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx) {
    try {
      let gitArgs = 'diff';
      if (args['file'] !== undefined) {
        const file = getStringArg(args, 'file', false);
        if (file) {
          // Validate the path stays in the workspace before quoting it in.
          resolveWithin(ctx.workspaceDir, file);
          gitArgs = `diff -- ${shellQuote(file)}`;
        }
      }
      const out = await runGit(gitArgs, ctx);
      if (out.startsWith('Error:')) return out;
      return truncate(out.trim() === '' ? '(no changes)' : out, 10_000, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

const gitCommitTool: Tool = {
  definition: {
    name: 'git_commit',
    description: 'Stage all changes (`git add -A`) and commit with the given message.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (single line preferred).' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  needsApproval: true,
  async execute(args, ctx) {
    try {
      const message = getStringArg(args, 'message').replace(/[\r\n]+/g, ' ').trim();
      if (!message) return errorResult('Commit message must not be empty.');
      const out = await runGit(`add -A && git commit -m ${shellQuote(message)}`, ctx);
      return truncate(out, MAX_TOOL_RESULT_CHARS, ctx.workspaceDir);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_TOOLS: Tool[] = [
  ...createToolBlobTools(),
  readFileTool,
  writeFileTool,
  listFilesTool,
  shellExecTool,
  webSearchTool,
  webFetchTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  httpGetTool,
  // --- v0.89 (worker F4): data (6) + http (1) + text (4) + office-write (3) ---
  ...DATA_TOOLS,
  ...HTTP_TOOLS,
  ...TEXT_TOOLS,
  ...OFFICE_WRITE_TOOLS,
  // --- v0.95 (Team D1): internet data (10: search, clean fetch,
  // feeds x4, watches x4) ---
  ...INTERNET_DATA_TOOLS,
  // --- v1.02 (rescue port of v0.99/v1.00): context (2) + durable (2) +
  // orchestra (2) + gateway (2) + dream (1) + substrate (2) + ACP (1) = 12 ---
  ...RESCUE_V102_TOOLS,
  // --- v1.03 (Đội T1): CodeAct (1) + run fork/replay/stuck/compact (4) = 5 ---
  ...HARNESS_V103_TOOLS,
  // --- v1.03 (Đội T4): workspace v3 (7: create/exec/list/quota +
  // snapshot create/list/restore) ---
  ...WORKSPACE_TOOLS,
  // --- v1.03 (Team T6): fleet overview + scheduling + marketplace v3 (4) ---
  ...FLEET_V103_TOOLS,
  // --- v1.05 (Đội T3): OpenMausBot parity — doctor (1) + team YAML (3) +
  // model refresh (1) + per-bot computer v2 (2) + headless status (1) = 8 ---
  ...OPENMAUSBOT_V105_TOOLS,
  // --- v1.05 (Team T6): eval v3 (6) + fleet v4 (5) = 11 ---
  ...EVAL_FLEET_V105_TOOLS,
  // --- v1.06 (Đội T3): doctor (2) + team YAML (2) + driver registry (6) +
  // engine picker (4) = 14 ---
  ...DOCTOR_TOOLS,
  ...TEAM_YAML_TOOLS,
  ...DRIVER_TOOLS,
  ...ENGINE_PICKER_TOOLS,
  // --- v1.06 (Đội T6): platform v4 — fleet bot scheduling + fleet status + eval (5) ---
  ...PLATFORM_V4_TOOLS,
  // --- v1.07 (Đội T1): memory v8 — sleep status/config/run (3) +
  // local search (1) + provenance (1) + review list/decide (2) +
  // poisoning scan (1) + fleet export/import/status (3) + erase (1) = 12 ---
  ...MEMORY_V8_TOOLS,
  // --- v1.08 (Đội T1): memory v9 — sleep daemon status/config/run/log (4) +
  // version snapshot/history/diff/rollback (4) + shared register/list/acl/sync/write/resolve (6) = 14 ---
  ...MEMORY_V9_TOOLS,
  // --- v1.09 (Đội T2): memory v9 kiểu Letta — core_memory_* (7) +
  // recall record/search (2) + archival insert/search/promote/delete/stats (5) +
  // entity snapshot/restore/export/import/stats (5) + letta sleep run/proposals/decide/log (4) = 23 ---
  ...MEMORY_V9_LETTA_TOOLS,
  // --- v1.10 (Đội T1): memory v10 — Mem0 pipeline add (1) +
  // fused 3-signal query (1) + bi-temporal timeline (1) + stats (1) +
  // versioned blocks list/commit (2) + branch (1) + rollback (1) +
  // quarantine list/review (1) = 9 ---
  ...MEMORY_V10_TOOLS,
  // --- v1.11 (Doi T1): memory v11 — insert (1) + apply patch (1) +
  // block history list/diff/stats (1) + rollback (1) + render
  // <memory_blocks> (1) + shared blocks list/ensure-preset (1) +
  // shared write supervisor-only (1) + sleep record fast (1) +
  // sleep pass (1) = 9 ---
  ...MEMORY_V11_TOOLS,
  // --- v1.07 (Đội T2): harness v3 — delegate (1) + budget meter (1) + LLM profile (1) = 3 ---
  ...HARNESS_V107_TOOLS,
  // --- v1.08 (Đội T3): harness v4 — EventLog (6) + CodeAct run/loop (2) + dependency sweep (4) = 12 ---
  ...HARNESS_V4_TOOLS,
  // --- v1.07 (Đội T4): skills & plugins — directory skills (2) + plugin bundle (3) + hooks config (1) + inline secret (2) = 8 ---
  ...SKILLS_PLUGINS_V107_TOOLS,
  // --- v1.07 (Đội T6): fleet v4 teams — Agent Teams (2) + worktree isolation (1) +
  // router context strategy (1) + prompt-cache (1) = 5 ---
  ...FLEET_V4_TEAMS_TOOLS,
  // --- v1.08 (Đội T2): coding agent v2 — repo map build/query/symbol (3) +
  // architect plan/execute/status (3) + git commit/diff/revert/squash (4) = 10 ---
  ...CODING_V2_TOOLS,
  // --- v1.10 (Đội T4): coding agent v3 — repo map build/modules/budget-map/calls (4) +
  // team run/status (2) + eval run/suite/list (3) + router pick/record-failure/catalog (3) = 12 ---
  ...CODING_V3_TOOLS,
  // --- v1.11 (Đội T4): coding agent v4 — repo map PageRank v2 (4: build/rank/budget-map/invalidate) +
  // sub-agent visualizer (4: start/update/tree/detail) + ACP model switching (3: switch/history/status) +
  // coding profiles (3: list/get/apply) = 14 ---
  ...CODING_V4_TOOLS,
  // --- v1.08 (Đội T4): providers v2 — Composio v2 (8: poll/status/enable/
  // disable/health/trigger map/unmap/mappings) + provider health (5: status/
  // check/alerts/history/reset) + OpenRouter/Fireworks models + info (4) = 17 ---
  ...PROVIDERS_V108_TOOLS,
  // --- v1.08 (Đội T6): fleet v5 — campaign (5) + budget v2 (3) +
  // health dashboard (1) + conflict scan (1) = 10 ---
  ...FLEET_V5_TOOLS,
  // --- v1.09 (Đội T1): Agent Teams v1 — create (1) + add teammate (1) +
  // assign task (1) + claim (1) + complete (1) + send message (1) +
  // status (1) + mailbox (1) + list (1) + assess (1) + worktree (1) = 11 ---
  ...TEAM_V109_TOOLS,
  // --- v1.10 (Đội T3): Agent Teams v2 — claim/heartbeat/release/requeue (4) +
  // spawn/assign/aggregate/cost/complete/config/dashboard (7) +
  // mailbox send/inbox/outbox (3) + fork spawn/complete/merge/status (4) = 18 ---
  ...TEAM_V2_TOOLS,
  // --- v1.11 (Đội T3): Agent Teams v3 — create/spawn/send/claim/start/close (6) +
  // waves (1) + challenge/answer/resolve (3) + lead mode (1) + panes/pane log (2) +
  // cost (1) + dashboard (1) = 15 ---
  ...TEAM_V3_TOOLS,
  // --- v1.09 (Đội T6): fleet v6 — schedule (4) + quota nhóm (3) +
  // health (3) = 10 ---
  ...FLEET_V6_TOOLS,
  // --- v1.10 (Đội T6): fleet campaign v2 — create/list/rollout/
  // progress/rollback/report (6) + pause/resume/cancel/clone/plan (5) +
  // Composio mock toolkit (2) + Cerebras models (1) = 14 ---
  ...FLEET_V7_TOOLS,
  // --- v1.11 (Đội T2): Harbor eval — list/validate/run task (3) +
  // run suite (1) + export rollout (1) + profiles list/set/for-task (3) +
  // report (1) = 9 ---
  ...EVAL_V111_TOOLS,
  // --- v1.11 (Đội T5): voice v10 — session create/list/stats/stop/
  // delete (5) + simulate turn (1) + VAD v10 (1) + noise (1) +
  // bot voice preset (1) + realtime v2 (1) = 10 ---
  ...VOICE_V10_TOOLS,
  // --- v1.11 (Đội T6): fleet v8 — node probe/health/rebalance (3) +
  // dashboard (1) + incident list/record (2) + Composio mock v111 (2) +
  // connection list/disconnect/reconnect (3) + poll policy (1) +
  // SambaNova models (1) = 13 --
  ...FLEET_V8_TOOLS,
];

export function createDefaultTools(opts?: {
  /** When given, shell_exec runs in the local-exec-daemon (resolved lazily per call, so a dead daemon is re-created by the caller on the next call). */
  getDaemon?: () => ShellDaemon | null;
  /**
   * v0.55: resolver policy egress hiệu lực của team hiện tại (xem
   * `createShellExecTool`) — resolve lười mỗi lần shell_exec chạy.
   */
  getEgressPolicy?: () => EgressPolicy | null | undefined;
  /**
   * v0.95 (Team D1): internet-data wiring. When any of these is
   * given, the 10 internet-data placeholders in ALL_TOOLS are
   * replaced by bound tools (same lazy pattern as http_request
   * above) — never registered twice. `getInternetDataFile` resolves
   * the `<userData>/internet-data.json` state file (undefined =
   * memory-only store); `getBraveSearchApiKey` resolves the opt-in
   * Brave key; `onWatchChanged` fires per changed watch.
   */
  getInternetDataFile?: () => string | null | undefined;
  getBraveSearchApiKey?: () => string | null;
  onWatchChanged?: (event: WatchChangeEvent) => void;
  /**
   * v1.03 (Team T6): fleet/marketplace v3 wiring. When given, the 4
   * fleet v3 placeholders in ALL_TOOLS are replaced by bound tools
   * (same lazy pattern as internet-data) — never registered twice.
   * `getFleetV103BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`, marketplace state `<userData>/marketplace`,
   * plugins `<userData>/plugins`).
   */
  getFleetV103BaseDir?: () => string | null | undefined;
  /**
   * v1.05 (Đội T3): OpenMausBot-parity wiring. When given, the 8
   * v1.05 placeholders in ALL_TOOLS are replaced by bound tools
   * (same replace-in-place pattern as fleet v1.03) — same 8 names,
   * never a duplicate. `getOpenmausbotV105BaseDir` resolves the app
   * userData dir (team.json + team-computers.json live there).
   */
  getOpenmausbotV105BaseDir?: () => string | null | undefined;
  /**
   * v1.05 (Team T6): eval v3 / fleet v4 wiring. When given, the 11
   * eval v3 + fleet v4 placeholders in ALL_TOOLS are replaced by
   * bound tools (same replace-in-place pattern) — never registered
   * twice. `getEvalFleetV105BaseDir` resolves the app userData dir
   * (eval history `<userData>/eval-memory-history.json`, fleet root
   * `<userData>/fleet`).
   */
  getEvalFleetV105BaseDir?: () => string | null | undefined;
  /**
   * v1.06 (Đội T6): platform v4 wiring. When given, the 5 platform
   * v4 placeholders in ALL_TOOLS are replaced by bound tools (same
   * lazy pattern as fleet v3) — never registered twice.
   * `getPlatformV4BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`, eval reports `<userData>/eval-reports`).
   */
  getPlatformV4BaseDir?: () => string | null | undefined;
  /** v1.07 (Đội T1): memory v8 wiring. When given, the 12 memory v8
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v3) — never registered twice.
   * `getMemoryV8WorkspaceDir` resolves the bot workspace dir
   * (sleep policy/ledger, review queue, erasure audit live there).
   */
  getMemoryV8WorkspaceDir?: () => string | null | undefined;
  /**
   * v1.08 (Đội T1): memory v9 wiring. When given, the 14 memory v9
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v8) — never registered twice.
   * `getMemoryV9WorkspaceDir` resolves the bot workspace dir
   * (sleep policy/run log, snapshots, shared registry live there).
   * When the stored v9 policy is enabled, the per-workspace sleep
   * daemon is started right away so automatic runs work without a
   * manual tool call.
   */
  getMemoryV9WorkspaceDir?: () => string | null | undefined;
  /**
   * v1.10 (Đội T1): memory v10 wiring. When given, the 9 memory v10
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v9) — never registered twice.
   * `getMemoryV10WorkspaceDir` resolves the bot workspace dir
   * (memory-v10.json + quarantine + blocks live there).
   */
  getMemoryV10WorkspaceDir?: () => string | null | undefined;
  /**
   * v1.11 (Doi T1): memory v11 wiring. When given, the 9 memory v11
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v10) — never registered twice.
   * `getMemoryV11WorkspaceDir` resolves the bot workspace dir
   * (memory blocks + shared supervisors + sleep inbox live there).
   * `getMemoryV11BotId` resolves the calling bot id (actor
   * `agent:<botId>` for shared-block supervisor checks).
   */
  getMemoryV11WorkspaceDir?: () => string | null | undefined;
  getMemoryV11BotId?: () => string | null | undefined;
  /**
   * v1.08 (Đội T2): coding v2 wiring. When given, the 10 coding v2
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as memory v8) — never registered twice.
   * `getCodingV2WorkspaceDir` resolves the bot workspace dir (repo
   * map cache, architect plans, git repo live there).
   */
  getCodingV2WorkspaceDir?: () => string | null | undefined;
  /**
   * v1.10 (Đội T4): coding v3 wiring. When given, the 12 coding v3
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as coding v2) — never registered twice.
   * `getCodingV3WorkspaceDir` resolves the bot workspace dir (repo
   * map cache, team runs live there).
   */
  getCodingV3WorkspaceDir?: () => string | null | undefined;
  /**
   * v1.11 (Đội T4): coding v4 wiring. When given, the 14 coding v4
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as coding v3) — never registered twice.
   * `getCodingV4WorkspaceDir` resolves the bot workspace dir (repo
   * map cache v4, sub-agent trees, model sessions live there).
   */
  getCodingV4WorkspaceDir?: () => string | null | undefined;
  /**
   * v1.07 (Đội T4): skills & plugins wiring. When given, the 8 v1.07
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v3) — never registered twice.
   * The getter returns the resolvers the tools need (workspace dir,
   * plugins dir, SkillRegistry, HookRegistry, InlineSecretService);
   * any resolver left out makes only the tools that need it report
   * "not configured" — the others keep working.
   */
  getSkillsPluginsV107Opts?: () => SkillsPluginsV107ToolOptions | null | undefined;
  /**
   * v1.07 (Đội T6): fleet v4 teams wiring. When given, the 5 fleet
   * v4 teams placeholders in ALL_TOOLS are replaced by bound tools
   * (same lazy pattern as fleet v3) — never registered twice.
   * `getFleetV4TeamsBaseDir` resolves the app userData dir (fleet
   * root is `<userData>/fleet`).
   */
  getFleetV4TeamsBaseDir?: () => string | null | undefined;
  /**
   * v1.08 (Đội T6): fleet v5 wiring. When given, the 10 fleet v5
   * placeholders in ALL_TOOLS are replaced by bound tools (same lazy
   * pattern as fleet v3/v4) — never registered twice.
   * `getFleetV5BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`).
   */
  getFleetV5BaseDir?: () => string | null | undefined;
  /**
   * v1.09 (Đội T1): Agent Teams v1 wiring. When given, the 11 team
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v3/v4) — never registered
   * twice. `getAgentTeamsV109BaseDir` resolves the app userData dir
   * (teams file is `<userData>/agent-teams-v109.json`).
   */
  getAgentTeamsV109BaseDir?: () => string | null | undefined;
  /**
   * v1.09 (Đội T6): fleet v6 wiring. When given, the 10 fleet v6
   * placeholders in ALL_TOOLS are replaced by bound tools (same lazy
   * pattern as fleet v3/v5) — never registered twice.
   * `getFleetV6BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`).
   */
  getFleetV6BaseDir?: () => string | null | undefined;
  /**
   * v1.10 (Đội T6): fleet campaign v2 wiring. When given, the 14
   * fleet v7 placeholders in ALL_TOOLS are replaced by bound tools
   * (same replace-in-place pattern) — never registered twice.
   * `getFleetV7BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`). The 3 pure tools (mock toolkit list/
   * execute, cerebras models) work even unbound.
   */
  getFleetV7BaseDir?: () => string | null | undefined;
  /**
   * v1.11 (Đội T2): Harbor eval wiring. When given, the 9 eval v111
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getEvalV111BaseDir` resolves the app userData dir (Harbor tasks
   * `<userData>/harbor-tasks`, runs `<userData>/eval-harbor-reports`,
   * rollouts `<userData>/eval-harbor/rollouts.jsonl`, profiles
   * `<userData>/agent-profiles.json`).
   */
  getEvalV111BaseDir?: () => string | null | undefined;
  /** v1.11 (Đội T2): executor thật + test timeout cho eval v111 tools. */
  getEvalV111ToolOptions?: () => EvalV111ToolOptions | undefined;
  /**
   * v1.11 (Đội T5): voice v10 wiring. When given, the 10 voice v10
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getVoiceV10Manager` returns the host's VoiceV10Manager (or
   * null when voice is not wired — the placeholders then refuse
   * with a plain message). `hasVoiceV10LiveKey` is the Vault-backed
   * live-key check for voice_v10_realtime (default: no key).
   */
  getVoiceV10Manager?: () => import('./voiceV10Tools').VoiceV10ManagerLike | null;
  hasVoiceV10LiveKey?: () => boolean;
  /**
   * v1.11 (Đội T6): fleet v8 wiring. When given, the 13 fleet v8
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getFleetV8BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`, Composio state `<userData>/composio`).
   * The 8 pure tools (probe/health/rebalance, mock list/execute,
   * poll policy, SambaNova models) work even unbound.
   */
  getFleetV8BaseDir?: () => string | null | undefined;
  /**
   * v1.08 (Đội T4): providers v2 wiring. When given, the 17 v1.08
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v3) — never registered twice.
   * The getter returns the resolvers the tools need (health monitor,
   * status poller, trigger-mapping store, toolkit manager, status
   * fetcher, provider api-key getter); any resolver left out makes
   * only the tools that need it report "not configured" — the others
   * keep working.
   */
  getProvidersV108Opts?: () => ProvidersV108ToolOptions | null | undefined;
}): Tool[] {
  if (!opts?.getDaemon && !opts?.getEgressPolicy && !opts?.getInternetDataFile && !opts?.getBraveSearchApiKey && !opts?.onWatchChanged && !opts?.getFleetV103BaseDir && !opts?.getOpenmausbotV105BaseDir && !opts?.getEvalFleetV105BaseDir && !opts?.getPlatformV4BaseDir && !opts?.getMemoryV8WorkspaceDir && !opts?.getMemoryV9WorkspaceDir && !opts?.getMemoryV10WorkspaceDir && !opts?.getMemoryV11WorkspaceDir && !opts?.getMemoryV11BotId && !opts?.getSkillsPluginsV107Opts && !opts?.getFleetV4TeamsBaseDir && !opts?.getCodingV2WorkspaceDir && !opts?.getCodingV3WorkspaceDir && !opts?.getCodingV4WorkspaceDir && !opts?.getProvidersV108Opts && !opts?.getFleetV5BaseDir && !opts?.getAgentTeamsV109BaseDir && !opts?.getFleetV6BaseDir && !opts?.getFleetV7BaseDir && !opts?.getEvalV111BaseDir && !opts?.getVoiceV10Manager && !opts?.hasVoiceV10LiveKey && !opts?.getFleetV8BaseDir) return [...ALL_TOOLS];
  let tools = [...ALL_TOOLS];
  const idx = tools.indexOf(shellExecTool);
  if (idx !== -1) {
    tools[idx] = createShellExecTool(opts.getDaemon, { getEgressPolicy: opts.getEgressPolicy });
  }
  // v0.89 (worker F4): http_request bound to the team egress policy when
  // one is configured (same lazy-resolver pattern as shell_exec above);
  // without it the placeholder uses the SSRF guard (see httpTools.ts).
  if (opts?.getEgressPolicy) {
    const httpIdx = tools.findIndex((t) => t.definition.name === 'http_request');
    if (httpIdx !== -1) {
      tools[httpIdx] = createHttpTools({ getEgressPolicy: opts.getEgressPolicy })[0] as Tool;
    }
  }
  // v0.95 (Team D1): bind the internet-data tools when the host wires
  // them (state file / Brave key / watch-change callback). The bound
  // set REPLACES the placeholders in place (same order, same 10
  // names) so the registry never sees a duplicate.
  if (opts?.getInternetDataFile || opts?.getBraveSearchApiKey || opts?.onWatchChanged) {
    const bound = createInternetDataTools({
      stateFile: opts.getInternetDataFile?.() ?? undefined,
      getApiKey: (name: string) =>
        name === 'brave' ? (opts.getBraveSearchApiKey?.() ?? undefined) : undefined,
      getEgressPolicy: opts.getEgressPolicy,
      onWatchChanged: opts.onWatchChanged,
    });
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.03 (Team T6): bind the fleet/marketplace v3 tools when the host
  // wires them (userData dir). Same replace-in-place pattern as
  // internet-data above — same 4 names, never a duplicate.
  if (opts?.getFleetV103BaseDir) {
    const bound = createFleetV103Tools(opts.getFleetV103BaseDir, () =>
      tools.map((t) => t.definition.name),
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.05 (Đội T3): bind the OpenMausBot-parity tools when the host
  // wires them (userData dir). Same replace-in-place pattern — same 8
  // names, never a duplicate.
  if (opts?.getOpenmausbotV105BaseDir) {
    const bound = createOpenmausbotV105Tools({ getDataDir: opts.getOpenmausbotV105BaseDir });
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.05 (Team T6): bind the eval v3 / fleet v4 tools when the host
  // wires them (userData dir). Same replace-in-place pattern — same
  // 11 names, never a duplicate.
  if (opts?.getEvalFleetV105BaseDir) {
    const bound = createEvalFleetV105Tools(opts.getEvalFleetV105BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.06 (Đội T6): bind the platform v4 tools when the host wires
  // them (userData dir). Same replace-in-place pattern as fleet v3 —
  // same 5 names, never a duplicate.
  if (opts?.getPlatformV4BaseDir) {
    const bound = createPlatformV4Tools(opts.getPlatformV4BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.07 (Đội T1): bind the memory v8 tools when the host wires
  // them (workspace dir). Same replace-in-place pattern — same 12
  // names, never a duplicate. Without this opt the placeholders
  // refuse with a clear error (workspaceDir is required).
  if (opts?.getMemoryV8WorkspaceDir) {
    const workspaceDir = opts.getMemoryV8WorkspaceDir();
    if (workspaceDir) {
      const bound = createMemoryV8Tools({ workspaceDir });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.08 (Đội T1): bind the memory v9 tools when the host wires
  // them (workspace dir). Same replace-in-place pattern — same 14
  // names, never a duplicate. Without this opt the placeholders
  // refuse with a clear error (workspaceDir is required). When the
  // stored v9 policy is enabled, the per-workspace sleep daemon is
  // started right away so idle/scheduled/session-end runs work
  // without a manual tool call.
  if (opts?.getMemoryV9WorkspaceDir) {
    const workspaceDir = opts.getMemoryV9WorkspaceDir();
    if (workspaceDir) {
      const bound = createMemoryV9Tools({ workspaceDir });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
      try {
        const agent = getMemoryV9Agent(workspaceDir);
        if (agent.enabled) agent.start();
      } catch {
        // Daemon auto-start lỗi thì thôi — tool chạy tay vẫn được.
      }
    }
  }
  // v1.09 (Đội T2): bind the memory v9 Letta tools with the same
  // workspace dir as the v9 tools (same replace-in-place pattern —
  // same 23 names, never a duplicate). Without this opt the
  // placeholders refuse with a clear error (workspaceDir is required).
  if (opts?.getMemoryV9WorkspaceDir) {
    const workspaceDir = opts.getMemoryV9WorkspaceDir();
    if (workspaceDir) {
      const bound = createMemoryV9LettaTools({ workspaceDir });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.10 (Đội T1): bind the memory v10 tools when the host wires
  // them (workspace dir). Same replace-in-place pattern — same 9
  // names, never a duplicate. Without this opt the placeholders
  // refuse with a clear error (workspaceDir is required).
  if (opts?.getMemoryV10WorkspaceDir) {
    const workspaceDir = opts.getMemoryV10WorkspaceDir();
    if (workspaceDir) {
      const bound = createMemoryV10Tools({ workspaceDir });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.11 (Doi T1): bind the memory v11 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v10 —
  // same 9 names, never a duplicate. getMemoryV11BotId (optional)
  // sets the calling bot id for supervisor write checks.
  if (opts?.getMemoryV11WorkspaceDir) {
    const workspaceDir = opts.getMemoryV11WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV11BotId?.() ?? undefined;
      const bound = createMemoryV11Tools({ workspaceDir, ...(botId ? { botId } : {}) });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.07 (Đội T4): bind the skills & plugins tools when the host
  // wires them (workspace/plugins dirs + registries + secret
  // service). Same replace-in-place pattern — same 8 names, never a
  // duplicate.
  if (opts?.getSkillsPluginsV107Opts) {
    const bound = createSkillsPluginsV107Tools(opts.getSkillsPluginsV107Opts() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.07 (Đội T6): bind the fleet v4 teams tools when the host wires
  // them (userData dir). Same replace-in-place pattern as fleet v3 —
  // same 5 names, never a duplicate.
  if (opts?.getFleetV4TeamsBaseDir) {
    const bound = createFleetV4TeamsTools(opts.getFleetV4TeamsBaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.08 (Đội T2): bind the coding v2 tools when the host wires
  // them (workspace dir). Same replace-in-place pattern — same 10
  // names, never a duplicate. Without this opt the placeholders
  // refuse with a clear error (workspaceDir is required).
  if (opts?.getCodingV2WorkspaceDir) {
    const workspaceDir = opts.getCodingV2WorkspaceDir();
    if (workspaceDir) {
      const bound = createCodingV2Tools({ workspaceDir });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.10 (Đội T4): bind the coding v3 tools when the host wires
  // them (workspace dir). Same replace-in-place pattern — same 12
  // names, never a duplicate. Without this opt the placeholders
  // refuse with a clear error (workspaceDir is required).
  if (opts?.getCodingV3WorkspaceDir) {
    const workspaceDir = opts.getCodingV3WorkspaceDir();
    if (workspaceDir) {
      const bound = createCodingV3Tools({ workspaceDir });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.11 (Đội T4): bind the coding v4 tools when the host wires
  // them (workspace dir). Same replace-in-place pattern — same 14
  // names, never a duplicate. knownToolNames comes from the current
  // composed list so profile_apply can drop tools that are not in
  // the registry. Without this opt the placeholders refuse with a
  // clear error (workspaceDir is required).
  if (opts?.getCodingV4WorkspaceDir) {
    const workspaceDir = opts.getCodingV4WorkspaceDir();
    if (workspaceDir) {
      const bound = createCodingV4Tools({
        workspaceDir,
        knownToolNames: tools.map((t) => t.definition.name),
      });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.08 (Đội T4): bind the providers v2 tools when the host wires
  // them (health monitor / Composio managers / status fetcher).
  // Same replace-in-place pattern — same 17 names, never a duplicate.
  if (opts?.getProvidersV108Opts) {
    const bound = createProvidersV108Tools(opts.getProvidersV108Opts() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.08 (Đội T6): bind the fleet v5 tools when the host wires
  // them (userData dir). Same replace-in-place pattern as fleet v3 —
  // same 10 names, never a duplicate.
  if (opts?.getFleetV5BaseDir) {
    const bound = createFleetV5Tools(opts.getFleetV5BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.09 (Đội T1): bind the Agent Teams v1 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 11
  // names, never a duplicate.
  if (opts?.getAgentTeamsV109BaseDir) {
    const bound = createAgentTeamsV109Tools(opts.getAgentTeamsV109BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.10 (Đội T3): bind the Agent Teams v2 tools on the SAME userData
  // dir as v1 (v2 adds `teams-v2/<teamId>/` under it). Same
  // replace-in-place pattern — same 18 names, never a duplicate.
  if (opts?.getAgentTeamsV109BaseDir) {
    const bound = createAgentTeamsV2Tools(opts.getAgentTeamsV109BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.11 (Đội T3): bind the Agent Teams v3 tools on the SAME userData
  // dir as v1/v2 (v3 adds `teams-v3/<teamId>/v3.json` +
  // `teams-v3/sessions.json` under it). Same replace-in-place
  // pattern — same 15 names, never a duplicate.
  if (opts?.getAgentTeamsV109BaseDir) {
    const bound = createAgentTeamsV3Tools(opts.getAgentTeamsV109BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  if (opts?.getFleetV6BaseDir) {
    const bound = createFleetV6Tools(opts.getFleetV6BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  if (opts?.getFleetV7BaseDir) {
    const bound = createFleetV7Tools(opts.getFleetV7BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.11 (Đội T2): bind the Harbor eval tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 9
  // names, never a duplicate.
  if (opts?.getEvalV111BaseDir) {
    const bound = createEvalV111Tools(
      opts.getEvalV111BaseDir,
      opts.getEvalV111ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.11 (Đội T5): bind the voice v10 tools when the host wires
  // them (same replace-in-place pattern — same 10 names, never a duplicate).
  if (opts?.getVoiceV10Manager || opts?.hasVoiceV10LiveKey) {
    const bound = createVoiceV10Tools({
      ...(opts?.getVoiceV10Manager ? { getManager: opts.getVoiceV10Manager } : {}),
      ...(opts?.hasVoiceV10LiveKey ? { hasLiveKey: opts.hasVoiceV10LiveKey } : {}),
    });
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.11 (Đội T6): bind the fleet v8 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 13
  // names, never a duplicate.
  if (opts?.getFleetV8BaseDir) {
    const bound = createFleetV8Tools(opts.getFleetV8BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  return tools;
}
