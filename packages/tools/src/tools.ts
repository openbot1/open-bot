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
// --- v1.34 (Đội T6): fleet v21 tools (tier-aware scheduling, multi-node
// placement, durable automation v2, fleet dashboard — 18 tools) ---
import { FLEET_V21_TOOLS, createFleetV21Tools } from './fleetV21Tools';
import type { FleetV21ToolState } from './fleetV21Tools';
// --- v1.35 (Đội T6): fleet v22 tools (multi-user + per-bot computer +
// probe/partition + delegation + handoff + orchestration — 24 tools) ---
import { FLEET_V22_TOOLS, createFleetV22Tools } from './fleetV22Tools';
import type { FleetV22ToolState } from './fleetV22Tools';
// --- v1.36 (Đội T6): fleet v23 tools (topology + scheduler v2 +
// placement v2 + rebalance v2 + dashboard — 24 tools) ---
import { FLEET_V23_TOOLS, createFleetV23Tools } from './fleetV23Tools';
import type { FleetV23ToolState } from './fleetV23Tools';
// --- v1.37 (Đội T6): fleet v24 tools (automation dashboard + stop hook
// feedback + CIDR sandbox rules — 26 tools) ---
import { FLEET_V24_TOOLS, createFleetV24Tools } from './fleetV24Tools';
import type { FleetV24ToolState } from './fleetV24Tools';
// --- v1.38 (Đội T6): fleet v25 tools (multi-user roles + audit log +
// scheduled automations v2 — 28 tools) ---
import { FLEET_V25_TOOLS, createFleetV25Tools } from './fleetV25Tools';
import type { FleetV25ToolState } from './fleetV25Tools';
// --- v1.39 (Đội T6): fleet v26 tools (resource quotas + bot lifecycle +
// health + shared blocks + skill pack + hooks + plugins + MCP Apps +
// admission + dashboard — 34 tools) ---
import { FLEET_V26_TOOLS, createFleetV26Tools } from './fleetV26Tools';
import type { FleetV26ToolState } from './fleetV26Tools';
// --- v1.40 (Đội T6): fleet v27 tools (async run campaigns +
// scheduled automation templates + fleet quota v2 + dashboard — 30 tools) ---
import { FLEET_V27_TOOLS, createFleetV27Tools } from './fleetV27Tools';
import type { FleetV27ToolState } from './fleetV27Tools';
// --- v1.41 (Đội T6): fleet v28 tools (per-conversation sandbox runtime +
// profile-scoped secrets + conversation budget meter + presets per profile
// + dashboard — 30 tools) ---
import { FLEET_V28_TOOLS, createFleetV28Tools } from './fleetV28Tools';
import type { FleetV28ToolState } from './fleetV28Tools';
// --- v1.42 (Đội T6): fleet v29 tools (A2A task board + peer registry +
// allowlist admin + audit log + sensitive confirmations + snapshot + health — 37 tools) ---
import { FLEET_V29_TOOLS, createFleetV29Tools } from './fleetV29Tools';
import type { FleetV29ToolState } from './fleetV29Tools';
// --- v1.44 (Đội T6): fleet v30 tools (per-conversation isolation +
// board v2 + peer groups + admin policy + dashboard — 52 tools) ---
import { FLEET_V30_TOOLS, createFleetV30Tools } from './fleetV30Tools';
import type { FleetV30ToolState } from './fleetV30Tools';
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
// --- v1.12 (Doi T1): memory v12 tools (exact-string edit, token
// budget, compile <memory_blocks> co cache, system blocks, audit,
// sleep janitor) — 7 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V12_TOOLS, createMemoryV12Tools } from './memoryV12Tools';
// --- v1.15 (Doi T1): memory v14 tools (extract, fused search,
// state-at, quarantine, GDPR erase, eval, extract preview) — 8 tools,
// placeholder trong ALL_TOOLS ---
import { MEMORY_V14_TOOLS, createMemoryV14Tools } from './memoryV14Tools';
// --- v1.16 (Doi T1): memory v15 tools (consolidate add-only, hybrid
// search 4 tin hieu, state-at, time-travel, block edit/list, sleep
// reorganize, eval) — 8 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V15_TOOLS, createMemoryV15Tools } from './memoryV15Tools';
// --- v1.35 (Doi T1): memory v16 tools (core_memory_replace exact-match,
// block edit/list/pin, sleep consolidate + reorganize, extract/fuse da
// scope, validity set/query, archival recall/promote, eval) — 12 tools,
// placeholder trong ALL_TOOLS ---
import { MEMORY_V16_TOOLS, createMemoryV16Tools } from './memoryV16Tools';
// --- v1.18 (Đội T1): memory v17 tools (block lifecycle v2: template/
// pin/read-only/maxChars/quota, sleep scheduler v2, archival scoring
// promote/demote, block commit/history/rollback/audit git-backed,
// admission pipeline poisoning guard v2, eval 25 case) ---
import { MEMORY_V17_TOOLS, createMemoryV17Tools } from './memoryV17Tools';
// --- v1.36 (Doi T1): memory v17 mem0-style tools (add-only single-pass
// extract, entity linking <name>_entities + typed edge, conflict
// detector + resolver, retrieval fusion, bi-temporal state-at, scope
// audit, eval 40 case) — 11 tools, placeholder trong ALL_TOOLS ---
// LUU Y: ten memory_v17_* thuoc memory v17 kieu block cua v1.18; file nay
// dung tien to memory_v17_mem0_ de khong xung dot.
import { MEMORY_V17_MEM0_TOOLS, createMemoryV17Mem0Tools } from './memoryV17Mem0Tools';
// --- v1.19 (Đội T1-TEST): memory v18 tools (extract v2, hybrid retrieval
// 3 tin hieu, block edit guardrail v3 + rollback/drift, bi-temporal
// correct/snapshot, poisoning screen v3, GDPR erase, sleep consolidation
// v2, LOCOMO eval) — 12 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V18_TOOLS, createMemoryV18Tools } from './memoryV18Tools';
// --- v1.29 (Đội T1): memory v21 tools (portable memory OKF/MemFS/
// OpenHands: export/import/convert/validate/sync/tombstone/version/
// sleep/record/bundle-info) — 10 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V21_TOOLS, createMemoryV21Tools } from './memoryV21Tools';
// --- v1.37 (Đội T1): memory v22 tools (dreaming consolidation: dream/
// config/status/report/fact/wiki/budget/snapshot/rollback/audit) —
// 10 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V22_TOOLS, createMemoryV22Tools } from './memoryV22Tools';
// --- v1.38 (Đội T1): memory v23 tools (Mem0-style extract/consolidate
// local, fusion search 3 tin hieu, scope search, sleep v2, record CRUD,
// procedural skill, stats + eval) — 10 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V23_TOOLS, createMemoryV23Tools } from './memoryV23Tools';
// --- v1.39 (Đội T1): memory v24 tools (MemFS Markdown co version,
// ADD-only extract, admission, lesson kem evidence, shared block
// lien-bot, sleep, decay, conflict, fused search time-aware, stats)
// — 10 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V24_TOOLS, createMemoryV24Tools } from './memoryV24Tools';
// --- v1.40 (Đội T1): memory v25 tools (sleep-time consolidation
// agent, shared block lien-bot co read-only, fact edge bi-temporal,
// judge ADD/UPDATE/DELETE/NOISE kieu Mem0, config sleep, audit,
// stats) — 10 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V25_TOOLS, createMemoryV25Tools } from './memoryV25Tools';
// --- v1.41 (Đội T1): memory v26 tools (registry shared block da bot
// + audit ai/khi nao/cu/moi, conflict 2 agent sua cung block, budget
// token + curate trich xuat, archival search theo ngay/noi dung,
// recall theo ngay, template human/persona/task/project, quota moi
// bot, stats + export/import) — 10 tools, placeholder trong ALL_TOOLS ---
import { MEMORY_V26_TOOLS, createMemoryV26Tools } from './memoryV26Tools';
// --- v1.42 (Đội T1): A2A v1.0 tools (signed card, peer registry +
// allowlist, delegation gate, loopback server, guard, audit, stats)
// — 10 tools, placeholder trong ALL_TOOLS ---
import { A2A_V11_TOOLS, createA2aV11Tools } from './a2aV11Tools';
// --- v1.42 (Đội T3): memory v27 tools (add-only single-pass extraction
// + entity linking luc ghi + boosting luc search, fact graph bi-temporal
// dong edge cu thay vi xoa, episode provenance, time-travel chat, shared
// block bi-temporal tren nen v26, hybrid search) — 10 tools, placeholder
// trong ALL_TOOLS ---
import { MEMORY_V27_TOOLS, createMemoryV27Tools } from './memoryV27Tools';
// --- v1.44 (Đội T1): memory v28 — git-backed blocks (10 tools:
// block, block history, share, share audit, fact, fact query,
// time-travel, sleep, sleep config, stats), placeholder trong
// ALL_TOOLS ---
import { MEMORY_V28_TOOLS, createMemoryV28Tools } from './memoryV28Tools';
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
// --- v1.34 (Đội T2): Sandbox v2 — tiered isolation, policy-as-code,
// token broker, kill switch, per-run report (9 tools) ---
import { SANDBOX_V2_TOOLS, createSandboxV2Tools } from './sandboxV2Tools';
import type { SandboxV2ToolOptions } from './sandboxV2Tools';
// --- v1.35 (Đội T2): Sandbox v3 — deep sandbox: per-tier syscall
// allowlist, egress gate, lifetime cap + auto-stop, COW snapshots,
// pause/resume, Pre/PostToolUse hooks (15 tools) ---
import { SANDBOX_V3_TOOLS, createSandboxV3Tools } from './sandboxV3Tools';
import type { SandboxV3ToolOptions } from './sandboxV3Tools';
import { SANDBOX_V4_TOOLS, createSandboxV4Tools } from './sandboxV4Tools';
import type { SandboxV4ToolOptions } from './sandboxV4Tools';
import { SANDBOX_V5_TOOLS, createSandboxV5Tools } from './sandboxV5Tools';
import type { SandboxV5ToolOptions } from './sandboxV5Tools';
// --- v1.38 (Đội T3): Sandbox v6 — per-bot runtime: cgroup v2 enforce
// (CPU/RAM/process), exec audit hash-chained, secret scoping theo bot,
// disk quota đo lường, admission control (22 tools) — placeholder trong ALL_TOOLS ---
import { SANDBOX_V6_TOOLS, createSandboxV6Tools } from './sandboxV6Tools';
import type { SandboxV6ToolOptions } from './sandboxV6Tools';// --- v1.34 (Đội T4): Eval Harness v2 — task container hoá 2 loại +
// oracle + runner song song + scorer 4 chiều + regression gate (6 tools)
// — placeholder trong ALL_TOOLS ---
import { EVAL_HARNESS_V2_TOOLS, createEvalHarnessV2Tools } from './evalHarnessV2Tools';
import type { EvalHarnessV2ToolOptions } from './evalHarnessV2Tools';
// --- v1.35 (Đội T4): Eval Harness v3 — container spec + guardrails +
// tracing + registry + gate 6 ngưỡng (8 tools) — placeholder trong ALL_TOOLS ---
import { EVAL_HARNESS_V3_TOOLS, createEvalHarnessV3Tools } from './evalHarnessV3Tools';
import type { EvalHarnessV3ToolOptions } from './evalHarnessV3Tools';
// --- v1.12 (Đội T2): event-sourced conversation + CodeAct-lite +
// skill workspace on-demand (11 tools) — placeholder trong ALL_TOOLS ---
import { CONVERSATION_V112_TOOLS, createConversationV112Tools } from './conversationV112Tools';
import type { ConversationV112ToolOptions } from './conversationV112Tools';
// --- v1.11 (Đội T5): voice v10 — realtime v2 + VAD v10 + noise +
// bot voice presets + AG-UI voice v3 (10 tools) ---
import { VOICE_V10_TOOLS, createVoiceV10Tools } from './voiceV10Tools';
// --- v1.12 (Đội T5): voice v11 — VAD v11 + barge-in v11 state machine +
// turn-taking v11 + streaming TTS v11 (8 tools) ---
import { VOICE_V11_TOOLS, createVoiceV11Tools } from './voiceV11Tools';
import { FLEET_V8_TOOLS, createFleetV8Tools } from './fleetV8Tools';
// --- v1.12 (Đội T6): fleet scheduling v2 + automations v2 +
// Composio mock v112 + MCP Apps v112 (15 tools) ---
import { FLEET_V9_TOOLS, createFleetV9Tools } from './fleetV9Tools';
// --- v1.13 (Đội T1): Agent Skills loader v13 — SKILL.md validation +
// session index + internal registry + interop + marketplace + audit (8 tools) ---
import { SKILLS_V13_TOOLS, createSkillsV13Tools } from './skillsV13Tools';
// --- v1.34 (Đội T1): Agent Skills v14 — strict AAIF validation + dual-path
// discovery + progressive-disclosure loader + local index + import/export (10 tools) ---
import { SKILLS_V14_TOOLS, createSkillsV14Tools } from './skillsV14Tools';
// --- v1.36 (Đội T2): Agent Skills v15 — multi-platform (.agents canonical +
// .claude/.github/.codex/.opencode mirrors) + compatibility registry +
// budgeted disclosure + migration + mirror sync + audit + packs + export plan (17 tools) ---
import { SKILLS_V15_TOOLS, createSkillsV15Tools } from './skillsV15Tools';
// --- v1.13 (Đội T2): MCP Apps host v13 — ui:// registry + ui/ dialect +
// display modes + component kit (7 tools) ---
import { MCP_APPS_V113_TOOLS, createMcpAppsV113Tools } from './mcpAppsV113Tools';
// --- v1.14 (Đội T2): MCP Apps v2 + Tasks chuẩn 2026-07-28 — negotiation
// 2 chiều + gallery/template + bundler/CSP + permissions mic/camera +
// component kit v2 (8 tools) ---
import { MCP_APPS_V2_TOOLS, createMcpAppsV2Tools } from './mcpAppsV2Tools';
// --- v1.34 (Đội T3): MCP Apps host v14 — ui:// registry v14 + _meta.ui +
// text fallback bắt buộc + capability negotiation + bridge ui/* consent +
// sandbox CSP + preview panel + audit (8 tools) ---
import { MCP_APPS_V14_TOOLS, createMcpAppsV14Tools } from './mcpAppsV14Tools';
// --- v1.35 (Đội T3): MCP Apps host v15 — ui:// registry v15 + MIME
// profile + app manifest + host context + bridge JSON-RPC 2.0 +
// consent bắt buộc + auto-visualiser + Agent Skills tạo app (11 tools) ---
import { MCP_APPS_V15_TOOLS, createMcpAppsV15Tools } from './mcpAppsV15Tools';
// --- v1.36 (Đội T3): MCP Apps v16 + MCP 2026-07-28 — stateless client
// v16 + MRTR SEP-2322 + URL elicitation + extension negotiation +
// deprecation policy + Client ID Metadata + Apps v16 pipeline + migration (15 tools) ---
import { MCP_APPS_V16_TOOLS, createMcpAppsV16Tools } from './mcpAppsV16Tools';
// --- v1.13 (Đội T3): repo map v5 — topology + summaries + incremental
// index + code graph search + jump-to-definition (6 tools) ---
import { REPOMAP_V5_TOOLS, createRepomapV5Tools } from './repoMapV5Tools';
// --- v1.13 (Đội T4): coding agent v5 git-native — patch preview +
// auto-commit + /add + SWE-bench eval + rollback (11 tools) ---
import { CODING_V5_TOOLS, createCodingV5Tools } from './codingV5Tools';
// --- v1.14 (Đội T3): coding agent v6 — event-sourced log + CodeAct-lite
// v2 + security gate + condenser v2 + stuck + delegate + RouterLLM (7 tools) ---
import { CODING_V6_TOOLS, createCodingV6Tools } from './codingV6Tools';
import type { CodingV6ToolOptions } from './codingV6Tools';
import { CODING_V7_TOOLS, createCodingV7Tools } from './codingV7Tools';
import type { CodingV7ToolOptions } from './codingV7Tools';
import { CODING_V9_TOOLS, createCodingV9Tools } from './codingV9Tools';
import type { CodingV9ToolOptions } from './codingV9Tools';
import { CODING_V10_TOOLS, createCodingV10Tools } from './codingV10Tools';
import type { CodingV10ToolOptions } from './codingV10Tools';
import { CODING_V14_TOOLS, createCodingV14Tools } from './codingV14Tools';
import type { CodingV14ToolOptions } from './codingV14Tools';
import { CODING_V15_TOOLS, createCodingV15Tools } from './codingV15Tools';
import type { CodingV15ToolOptions } from './codingV15Tools';
import { CODING_V16_TOOLS, createCodingV16Tools } from './codingV16Tools';
import type { CodingV16ToolOptions } from './codingV16Tools';
import { CODING_V17_TOOLS, createCodingV17Tools } from './codingV17Tools';
import type { CodingV17ToolOptions } from './codingV17Tools';
import { CODING_V18_TOOLS, createCodingV18Tools } from './codingV18Tools';
import type { CodingV18ToolOptions } from './codingV18Tools';
// --- v1.41 (Đội T4): coding agent v19 tools (event-backed conversation +
// workspace tách bạch + plugins mcp.json + presets + marketplace + agent) ---
import { CODING_V19_TOOLS, createCodingV19Tools } from './codingV19Tools';
import type { CodingV19ToolOptions } from './codingV19Tools';// --- v1.29 (Đội T2): protocols v5 — negotiate/bg-tasks/permission-policy/
// oauth/acp (12 tools, placeholder trong ALL_TOOLS, bind qua
// createProtocolV5Tools) ---
import { PROTOCOL_V5_TOOLS, createProtocolV5Tools } from './protocolV5Tools';
import type { ProtocolV5ToolOptions } from './protocolV5Tools';
// --- v1.37 (Đội T2): protocols v6 — negotiate/versions/acp session+
// update+file-changes/elicit form+url+modes/a2a stream start+send+
// control/registry (12 tools, placeholder trong ALL_TOOLS, bind qua
// createProtocolV6Tools) ---
import { PROTOCOL_V6_TOOLS, createProtocolV6Tools } from './protocolV6Tools';
import type { ProtocolV6ToolOptions } from './protocolV6Tools';
// --- v1.38 (Đội T2): protocols v7 — negotiate/versions/a2a card+task+
// client+server/mcp stateless/ucp catalog+order/govern delegate+
// escalate+audit (12 tools, placeholder trong ALL_TOOLS, bind qua
// createProtocolV7Tools) ---
import { PROTOCOL_V7_TOOLS, createProtocolV7Tools } from './protocolV7Tools';
import type { ProtocolV7ToolOptions } from './protocolV7Tools';
// --- v1.39 (Đội T2): protocols v8 — discover/versions/extensions (3) +
// stateless/legacy (2) + apps/tasks (2) + oauth/deprecation (2) + nanda/
// server-card/skills (3) = 12 tools, placeholder trong ALL_TOOLS, bind qua
// createProtocolV116Tools ---
import { PROTOCOL_V116_TOOLS, createProtocolV116Tools } from './protocolV116Tools';
import type { ProtocolV116ToolOptions } from './protocolV116Tools';
// --- v1.40 (Đội T2): protocols v9 — versions (1) + apps/apps-lifecycle (2) +
// acp detect/sessions/prompt (3) + a2a cards/tasks/messages/delegate (4) +
// registry/snapshots (2) = 12 tools, placeholder trong ALL_TOOLS, bind qua
// createProtocolV117Tools ---
import { PROTOCOL_V117_TOOLS, createProtocolV117Tools } from './protocolV117Tools';
import type { ProtocolV117ToolOptions } from './protocolV117Tools';
// --- v1.41 (Đội T2): protocols v10 — versions (1) + stateless (1) + oauth (1) +
// tool search/script (2) + tasks (1) + apps/apps-bridge (2) + roundtrip (1) +
// a2a (1) + deprecation (1) + registry (1) = 12 tools, placeholder trong
// ALL_TOOLS, bind qua createProtocolV118Tools ---
import { PROTOCOL_V118_TOOLS, createProtocolV118Tools } from './protocolV118Tools';
import type { ProtocolV118ToolOptions } from './protocolV118Tools';
// --- v1.42 (Đội T2): protocols v11 — MCP 2.0 stateless core (versions (1) +
// stateless (1) + discover (1) + cache (1) + roundtrip (1) + tasks (1) +
// oauth (1) + interop (1) + apps (1) + deprecation (1) + meta (1) + registry (1)
// = 12 tools, placeholder trong ALL_TOOLS, bind qua createProtocolV119Tools ---
import { PROTOCOL_V119_TOOLS, createProtocolV119Tools } from './protocolsV11Tools';
import type { ProtocolV119ToolOptions } from './protocolsV11Tools';
// --- v1.13 (Đội T5): voice v12 realtime — barge-in + TTS streaming +
// turn-taking + overlap (8 tools) ---
import { VOICE_V12_TOOLS, createVoiceV12Tools } from './voiceV12Tools';
// --- v1.14 (Đội T5): voice v13 realtime — barge-in engine + clause TTS +
// Smart Turn + latency budget + wake word + providers (8 tools) ---
import { VOICE_V13_TOOLS, createVoiceV13Tools } from './voiceV13Tools';
// --- v1.15 (Đội T5): voice v14 realtime — latency budget v2 +
// providers v2 + Smart Turn v2 + wake word v2 + barge-in v2 (9 tools) ---
import { VOICE_V14_TOOLS, createVoiceV14Tools } from './voiceV14Tools';
// --- v1.27 (Đội T5): voice v19 realtime — session manager v19 +
// prosody control + eval v19 + open-turn resume (13 tools) ---
// Ported into v1.29 from merge/v128; wired into ALL_TOOLS here
// (v128 exported it but never spread it — pinned-count note).
import { VOICE_V19_TOOLS, createVoiceV19Tools } from './voiceV19Tools';
import type { VoiceV19ToolOptions } from './voiceV19Tools';
// --- v1.29 (Đội T5): voice v20 extensions — durable session
// persistence, resume v2, open-turn v8, transcript accuracy,
// extended eval harness (8 tools) ---
import { VOICE_V20_TOOLS, createVoiceV20Tools } from './voiceV20Tools';
import type { VoiceV20ToolOptions } from './voiceV20Tools';
// --- v1.34 (Đội T5): voice v21 realtime — voice-driven tool
// calls + spoken confirmation, turn-taking, barge-in, WER/latency
// eval, streaming TTS cache, monitor panel (8 tools) ---
import { VOICE_V21_TOOLS, createVoiceV21Tools } from './voiceV21Tools';
import type { VoiceV21ToolOptions } from './voiceV21Tools';
// --- v1.35 (Đội T5): voice v22 durable realtime — durable
// session, barge-in v2, floor turn-taking, voice profiles,
// recovery loop, durability monitor (6 tools) ---
import { VOICE_V22_TOOLS, createVoiceV22Tools } from './voiceV22Tools';
import type { VoiceV22ToolOptions } from './voiceV22Tools';
// --- v1.36 (Đội T5): voice v23 eval + streaming + endpointing +
// interruption v2, session manager v2, calibration + device
// profiles, monitor panel v2 (7 tools) ---
import { VOICE_V23_TOOLS, createVoiceV23Tools } from './voiceV23Tools';
import type { VoiceV23ToolOptions } from './voiceV23Tools';
// --- v1.37 (Đội T5): voice v24 — per-tool-call timers,
 // dynamic providers + health, mid-session model switch,
 // session, panel, report, fallback chains, budgets (9) ---
import { VOICE_V24_TOOLS, createVoiceV24Tools } from './voiceV24Tools';
import type { VoiceV24ToolOptions } from './voiceV24Tools';
// --- v1.38 (Đội T5): voice v25 — turn-level barge-in, turn-taking +
// silence detection, real per-provider latency + fallback, per-voice-turn
// timers, session, panel, report (7) ---
import { VOICE_V25_TOOLS, createVoiceV25Tools } from './voiceV25Tools';
import type { VoiceV25ToolOptions } from './voiceV25Tools';
// --- v1.39 (Đội T5): voice v26 — frame-level barge-in, guarded
// turn-taking, latency budget + degraded mode, expanded TTS/STT
// providers, session, live status panel + ui:// resource (8) ---
import { VOICE_V26_TOOLS, createVoiceV26Tools } from './voiceV26Tools';
import type { VoiceV26ToolOptions } from './voiceV26Tools';
// --- v1.40 (Đội T5): voice v27 — barge-in v2 (interrupt policy +
// event log), VAD tuning + turn-taking v2, multi-voice personas,
// durable session state + store, report (6) ---
import { VOICE_V27_TOOLS, createVoiceV27Tools } from './voiceV27Tools';
import type { VoiceV27ToolOptions } from './voiceV27Tools';
import { VOICE_V28_TOOLS, createVoiceV28Tools } from './voiceV28Tools';
import type { VoiceV28ToolOptions } from './voiceV28Tools';
// --- v1.42 (Đội T4): voice v29 — full-duplex (turn detector +
// barge-in, append-only context, delegated async tools, proactive
// audio, cascaded pipeline, per-minute cost) (7) ---
import { VOICE_V29_TOOLS, createVoiceV29Tools } from './voiceV29Tools';
import type { VoiceV29ToolOptions } from './voiceV29Tools';
// --- v1.44 (Đội T4): voice v30 — full-duplex v2 (turn detector v2 +
// two-lane duplex, barge-in v2, proactive audio v2, cost ledger v2) (6) ---
import { VOICE_V30_TOOLS, createVoiceV30Tools } from './voiceV30Tools';
import type { VoiceV30ToolOptions } from './voiceV30Tools';
// --- v1.13 (Đội T6): fleet v10 — event triggers + schedules +
// multi-user + ACP dashboard (11 tools) ---
import { FLEET_V10_TOOLS, createFleetV10Tools } from './fleetV10Tools';
// --- v1.14 (Đội T4): Composio v114 — mock toolkits + poll scheduler v2 +
// connection health + trigger templates + MCP App bridge (6 tools) ---
import { COMPOSIO_V114_TOOLS, createComposioV114Tools } from './composioV114Tools';
// --- v1.18 (Đội T4): Composio v118 — mock toolkits canva/pandadoc/loom +
// polling v5 adaptive + trigger instances + OAuth state machine +
// webhook ingestion (6 tools) ---
import { COMPOSIO_V118_TOOLS, createComposioV118Tools } from './composioV118Tools';
// --- v1.19 (Đội T4): Composio v119 — mock toolkits wrike/bamboohr/
// ringcentral + polling v6 batch + trigger instances v2 + OAuth
// refresh v2 + webhook v2 queue + toolkit prefs per-user + usage
// metering (8 tools) ---
import { COMPOSIO_V119_TOOLS, createComposioV119Tools } from './composioV119Tools';
// --- v1.29 (Đội T4): Composio v6 — long jobs submit/poll/get/list/
// cancel (5) + mock toolkits list/execute (2) + sandbox create/status
// (2) + app bind (1) = 10 ---
import { COMPOSIO_V129_TOOLS, createComposioV129Tools } from './composioV129Tools';
import type { ComposioV129ToolOptions } from './composioV129Tools';
// --- v1.14 (Đội T6): fleet v11 — health + staged rollout + panels (9 tools) ---
import { FLEET_V11_TOOLS, createFleetV11Tools } from './fleetV11Tools';
// --- v1.15 (Đội T3): local model router — catalogue + load/unload +
// route decide + budget/spend + virtual key (10 tools) ---
import { ROUTER_LOCAL_V115_TOOLS, createRouterLocalV115Tools } from './routerLocalV115Tools';
// --- v1.39 (Đội T3): local model router v116 — scoring profiles +
// fallback chain/circuit-breaker + CLI sources (6 CLI moi) +
// continuous batching + health probe (11 tools) ---
import { ROUTER_LOCAL_V116_TOOLS, createRouterLocalV116Tools } from './routerLocalV116Tools';
import type { RouterLocalV116State } from './routerLocalV116Tools';
// --- v1.40 (Đội T3): local model router v117 — mid-chat RouterLLM +
// risk scoring (LLMSecurityAnalyzer) + confirmation policy (13 tools) ---
import { ROUTER_LOCAL_V117_TOOLS, createRouterLocalV117Tools } from './routerLocalV117Tools';
import type { RouterLocalV117State } from './routerLocalV117Tools';
// --- v1.41 (Đội T3): local model router v118 — programmatic tool
// calling + tool_choice theo provider moi + inline-tools (15 tools) ---
import { ROUTER_LOCAL_V118_TOOLS, createRouterLocalV118Tools } from './routerLocalV118Tools';
import type { RouterLocalV118State } from './routerLocalV118Tools';
// --- v1.42 (Đội T5): router + provider v29 — refresh model catalog
// (Gemini 3.x live, gpt-realtime-2.1, GPT-Live, Gemini 3.8 Live),
// routing latency/cost/capability, per-model cost ledger, fallback
// chain, mock health probe, provider config, forecast, policy (15 tools) ---
import { ROUTER_V29_TOOLS, createRouterV29Tools } from './routerV29Tools';
import type { RouterV29State } from './routerV29Tools';
import { ROUTER_V30_TOOLS, createRouterV30Tools } from './routerV30Tools';
import type { RouterV30State } from './routerV30Tools';
// --- v1.15 (Đội T6): fleet v12 — model pinning + % rollout + health v12 + panels (9 tools) ---
import { FLEET_V12_TOOLS, createFleetV12Tools } from './fleetV12Tools';
// --- v1.18 (Đội T3): local-model router v3 — catalog 100+ provider +
// capability check + cost estimate + rank + chat + local scan/status +
// cost set + circuit + latency (10 tools) ---
import { ROUTER_V3_TOOLS, createRouterV3Tools } from './routerV3Tools';
import type { RouterV3State } from './routerV3Tools';
// --- v1.33 (Đội T5): inference broker v2 — capability matrix 4 engine
// local + probe that + validate tool call + prefix cache + voice v22
// (7 tools) ---
import { INFERENCE_BROKER_V2_TOOLS, createInferenceBrokerV2Tools } from './inferenceBrokerV2Tools';
import type { InferenceBrokerV2State } from './inferenceBrokerV2Tools';

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
  // --- v1.34 (Đội T6): fleet v21 — tier-aware scheduling + multi-node
  // placement + durable automation v2 + fleet dashboard (18) ---
  ...FLEET_V21_TOOLS,
  // --- v1.35 (Đội T6): fleet v22 — multi-user + per-bot computer +
  // probe/partition + delegation + handoff + orchestration (24) ---
  ...FLEET_V22_TOOLS,
  // --- v1.36 (Đội T6): fleet v23 — topology + scheduler v2 +
  // placement v2 + rebalance v2 + fleet dashboard (24) ---
  ...FLEET_V23_TOOLS,
  // --- v1.37 (Đội T6): fleet v24 — automation dashboard (tag/owner) +
  // run ledger + stop hook feedback + CIDR sandbox rules (26) ---
  ...FLEET_V24_TOOLS,
  // --- v1.38 (Đội T6): fleet v25 — multi-user roles + audit log +
  // scheduled automations v2 (28) ---
  ...FLEET_V25_TOOLS,
  // --- v1.39 (Đội T6): fleet v26 — resource quotas + bot lifecycle +
  // health + shared blocks + skill pack + hooks + plugins + MCP Apps +
  // admission + dashboard (34) ---
  ...FLEET_V26_TOOLS,
  // --- v1.40 (Đội T6): fleet v27 — async run campaigns (10) +
  // scheduled automation templates + automations (10) + fleet quota v2 (9)
  // + dashboard (1) = 30 ---
  ...FLEET_V27_TOOLS,
  // --- v1.41 (Đội T6): fleet v28 — per-conversation sandbox runtime (11) +
  // profile-scoped secrets (7) + conversation budget meter (8) + forecast (3) +
  // sandbox policy (4) + conversation adapter (3) + presets per profile (3) +
  // dashboard (1) = 40 ---
  ...FLEET_V28_TOOLS,
  // --- v1.42 (Đội T6): fleet v29 — peer registry (8) + task board (11) +
  // allowlist admin (7) + audit log (3) + sensitive confirmations (4) +
  // snapshot (2) + health (1) + dashboard (1) = 37 ---
  ...FLEET_V29_TOOLS,
  // --- v1.44 (Đội T6): fleet v30 — isolation (9) + drivers (3) +
  // board v2 (12) + saved views (4) + peer groups (10) + admin
  // policy (13) + quotas (4) + snapshot (2) + dashboard (1) = 60 ---
  ...FLEET_V30_TOOLS,
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
  // --- v1.12 (Doi T1): memory v12 — exact-string edit (1) + search (1) +
  // token usage (1) + compile <memory_blocks> (1) + system block (1) +
  // audit trail (1) + sleep janitor (1) + export (1) + import (1) = 9 ---
  ...MEMORY_V12_TOOLS,
  // --- v1.15 (Doi T1): memory v14 — extract (1) + fused search (1) +
  // state-at (1) + quarantine list (1) + quarantine review (1) +
  // erase (1) + eval (1) + extract preview (1) = 8 ---
  ...MEMORY_V14_TOOLS,
  // --- v1.16 (Doi T1): memory v15 — consolidate (1) + hybrid search (1) +
  // state-at (1) + time-travel (1) + block edit (1) + block list (1) +
  // sleep reorganize (1) + eval (1) = 8 ---
  ...MEMORY_V15_TOOLS,
  // --- v1.35 (Doi T1): memory v16 — core_memory_replace (1) + block edit
  // (1) + block list (1) + block pin (1) + block audit (1) + sleep
  // consolidate (1) + extract/fuse (1) + validity set (1) + validity
  // query (1) + archival recall (1) + archival promote (1) + sleep
  // reorganize (1) + eval (1) = 13 ---
  ...MEMORY_V16_TOOLS,
  // --- v1.18 (Doi T1): memory v17 — block template (1) + lifecycle (1) +
  // compile (1) + sleep schedule (1) + archival score (1) + block
  // commit (1) + history/diff (1) + rollback (1) + audit (1) + admit (1) +
  // eval (1) = 11 ---
  ...MEMORY_V17_TOOLS,
  // --- v1.36 (Doi T1): memory v17 mem0-style — extract (1) + entity link
  // (1) + entity list (1) + entity merge (1) + conflict list (1) +
  // conflict resolve (1) + search (1) + state-at (1) + fact timeline (1)
  // + scope audit (1) + eval (1) = 11 ---
  // LUU Y: ten memory_v17_* (khong co _mem0_) thuoc memory v17 kieu block
  // cua v1.18; tool nay dung tien to memory_v17_mem0_ de khong xung dot.
  ...MEMORY_V17_MEM0_TOOLS,
  // --- v1.19 (Đội T1-TEST): memory v18 — extract (1) + retrieve (1) +
  // block edit (1) + rollback (1) + drift/audit (1) + correct/timeline
  // (1) + snapshot (1) + screen/trust/review (1) + erase (1) + sleep
  // (1) + eval (1) + erase audit (1) = 12 ---
  ...MEMORY_V18_TOOLS,
  // --- v1.29 (Đội T1): memory v21 — export (1) + import (1) + convert (1)
  // + validate (1) + sync (1) + tombstone (1) + version (1) + sleep (1)
  // + record (1) + bundle info (1) = 10 ---
  ...MEMORY_V21_TOOLS,
  // --- v1.37 (Đội T1): memory v22 — dream (1) + config (1) + status (1)
  // + report (1) + fact (1) + wiki (1) + budget (1) + snapshot (1)
  // + rollback (1) + audit (1) = 10 ---
  ...MEMORY_V22_TOOLS,
  // --- v1.38 (Đội T1): memory v23 — add (1) + extract (1) + search (1)
  // + scope search (1) + consolidate (1) + sleep (1) + record (1)
  // + skill (1) + skill search (1) + stats (1) = 10 ---
  ...MEMORY_V23_TOOLS,
  // --- v1.39 (Đội T1): memory v24 — add (1) + memfs (1) + search (1)
  // + lesson (1) + block (1) + sleep (1) + decay (1) + admission (1)
  // + conflict (1) + stats (1) = 10 ---
  ...MEMORY_V24_TOOLS,
  // --- v1.40 (Đội T1): memory v25 — sleep (1) + block (1) + fact (1)
  // + judge (1) + add (1) + search (1) + consolidate (1) + config (1)
  // + audit (1) + stats (1) = 10 ---
  ...MEMORY_V25_TOOLS,
  // --- v1.41 (Đội T1): memory v26 — registry (1) + block (1) +
  // conflict (1) + audit (1) + budget (1) + curate (1) + archival (1)
  // + recall (1) + template (1) + stats (1) = 10 ---
  ...MEMORY_V26_TOOLS,
  // --- v1.42 (Đội T1): A2A v1.0 — card (1) + peer (1) + delegate (1)
  // + send (1) + task (1) + guard (1) + audit (1) + server (1) +
  // sign (1) + stats (1) = 10 ---
  ...A2A_V11_TOOLS,
  // --- v1.42 (Đội T3): memory v27 — ingest (1) + extract dry-run (1) +
  // fact (1) + search (1) + time-travel (1) + entity (1) + episode (1)
  // + graph (1) + block bi-temporal (1) + stats (1) = 10 ---
  ...MEMORY_V27_TOOLS,
  // --- v1.44 (Đội T1): memory v28 — block (1) + block history (1) +
  // share (1) + share audit (1) + fact (1) + fact query (1) +
  // time-travel (1) + sleep (1) + sleep config (1) + stats (1) = 10 ---
  ...MEMORY_V28_TOOLS,
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
  // --- v1.34 (Đội T2): Sandbox v2 — list/validate/select (3) + run (1) +
  // report (1) + token issue/revoke (2) + microVM dry-run (1) + kill (1) = 9 ---
  ...SANDBOX_V2_TOOLS,
  // --- v1.35 (Đội T2): Sandbox v3 — list/validate (2) + session
  // create/list (2) + run command/step (2) + report (1) + pause/
  // resume/stop (3) + snapshot/restore (2) + egress/syscall check (2) +
  // hook register (1) = 15 ---
  ...SANDBOX_V3_TOOLS,
  // --- v1.36 (Đội T4): Sandbox v4 — runtime create/list/report/
  // stop/cleanup (5) + profile list/validate/create/set (4) +
  // budget status/set-limits/record (3) + secret request/approve/
  // deny/list (4) + depmap build/order/conflicts (3) = 19 ---
  ...SANDBOX_V4_TOOLS,
  // --- v1.37 (Đội T3): Sandbox v5 — tier list (1) + choice set/get/
  // list (3) + runtime register/list/stop (3) + switch plan/switch
  // (2) + archive scan/create/list/restore/delete (5) + disk
  // status/reclaim (2) + secret grant/consume/list/revoke/end-run/
  // audit (6) = 22 ---
  ...SANDBOX_V5_TOOLS,
  // --- v1.38 (Đội T3): Sandbox v6 — runtime create/list/report/
  // pause/resume/stop/destroy (7) + quota get/set/presets (3) +
  // exec (1) + usage (1) + audit query/summary/export (3) + enforcement verify (1) +
  // disk reclaim (1) + secret put/get/list/revoke/grant (5) = 22 ---
  ...SANDBOX_V6_TOOLS,
  // --- v1.34 (Đội T4): Eval Harness v2 — list/validate/run task (3) +
  // run suite (1) + baseline (1) + gate (1) = 6 ---
  ...EVAL_HARNESS_V2_TOOLS,
  // --- v1.35 (Đội T4): Eval Harness v3 — list/validate/run task (3) +
  // run suite (1) + run set (1) + baseline (1) + gate (1) + trace (1) = 8 ---
  ...EVAL_HARNESS_V3_TOOLS,
  // --- v1.12 (Đội T2): event-sourced conversation — start/append/
  // replay/branch/snapshot/compact/export/timetravel (8) + CodeAct-lite
  // run text (1) + skill workspace list/load (2) = 11 ---
  ...CONVERSATION_V112_TOOLS,
  // --- v1.11 (Đội T5): voice v10 — session create/list/stats/stop/
  // delete (5) + simulate turn (1) + VAD v10 (1) + noise (1) +
  // bot voice preset (1) + realtime v2 (1) = 10 ---
  ...VOICE_V10_TOOLS,
  // --- v1.12 (Đội T5): voice v11 — session create/list/stats/stop/
  // delete (5) + feed text (1) + interrupt (1) + VAD v11 (1) = 8 ---
  ...VOICE_V11_TOOLS,
  // --- v1.11 (Đội T6): fleet v8 — node probe/health/rebalance (3) +
  // dashboard (1) + incident list/record (2) + Composio mock v111 (2) +
  // connection list/disconnect/reconnect (3) + poll policy (1) +
  // SambaNova models (1) = 13 --
  ...FLEET_V8_TOOLS,
  // --- v1.12 (Đội T6): fleet scheduling v2 — schedule create/list/
  // enable (3) + queue tick/list (2) + day plan (1) + automations v2 —
  // create/list/dry-run/run-log (4) + Composio mock v112 list/execute
  // (2) + MCP Apps v112 catalogue/install/uninstall (3) = 15 ---
  ...FLEET_V9_TOOLS,
  // --- v1.13 (Đội T1): Agent Skills loader v13 (8) ---
  ...SKILLS_V13_TOOLS,
  // --- v1.34 (Đội T1): Agent Skills v14 (10) ---
  ...SKILLS_V14_TOOLS,
  // --- v1.36 (Đội T2): Agent Skills v15 — platforms/status/export-multi/
  // import-multi/remove (5) + validate-platform/compat/disclose (3) +
  // registry/sync/sync-repair/migrate (4) + audit/pack-create/pack-verify/
  // pack-install/export-plan (5) = 17 ---
  ...SKILLS_V15_TOOLS,
  // --- v1.13 (Đội T2): MCP Apps host v13 (7) ---
  ...MCP_APPS_V113_TOOLS,
  // --- v1.14 (Đội T2): MCP Apps v2 + Tasks chuẩn 2026-07-28 (8) ---
  ...MCP_APPS_V2_TOOLS,
  // --- v1.34 (Đội T3): MCP Apps host v14 (8) ---
  ...MCP_APPS_V14_TOOLS,
  // --- v1.35 (Đội T3): MCP Apps host v15 (11) ---
  ...MCP_APPS_V15_TOOLS,
  // --- v1.36 (Đội T3): MCP Apps v16 + MCP 2026-07-28 (15) ---
  ...MCP_APPS_V16_TOOLS,
  // --- v1.13 (Đội T3): repo map v5 (6) ---
  ...REPOMAP_V5_TOOLS,
  // --- v1.13 (Đội T4): coding agent v5 git-native (11) ---
  ...CODING_V5_TOOLS,
  // --- v1.14 (Đội T3): coding agent v6 — start/run_text/approve/
  // replay/security/condense/delegate (7) ---
  ...CODING_V6_TOOLS,
  // --- v1.15 (Đội T4): coding agent v7 — start/step/pause/resume/
  // replay/security/condense/skills/eval (9) ---
  ...CODING_V7_TOOLS,
  // --- v1.17 (Đội T4): coding agent v9 — ast-edit/loop/commit/pr/
  // eval/agent (6) ---
  ...CODING_V9_TOOLS,
  // --- v1.18 (Đội T2): coding agent v10 — session/codeact/repomap/
  // edit/eval/agent/snapshot (7) ---
  ...CODING_V10_TOOLS,
  // --- v1.29 (Đội T3): coding agent v14 — condense/stuck-check/
  // recover/reasoning/agent/resume (6) ---
  ...CODING_V14_TOOLS,
  // --- v1.37 (Đội T4): coding agent v15 — profile create/list/
  // apply/update/delete/clone (6) + budget report/history (2) +
  // hooks dialog (1) + verify (1) + agent (1) + run report (1) +
  // verify history (1) + eval (1) = 14 ---
  ...CODING_V15_TOOLS,
  // --- v1.38 (Đội T4): coding agent v16 — budget/cost/minimal/
  // file-window/lint-edit/trim/benchmark (7) ---
  ...CODING_V16_TOOLS,  // --- v1.29 (Đội T2): protocols v5 — negotiate/bg-task start/get/
  // --- v1.39 (Đội T4): coding agent v17 — trajectory/repomap/eval/
  // critic/review/plan/sandbox/agent/verify (9) ---
  ...CODING_V17_TOOLS,
  // --- v1.40 (Đội T4): coding agent v18 — critic/review/depmap/
  // zones/eval/verify/agent/config (8) ---
  ...CODING_V18_TOOLS,
  // --- v1.41 (Đội T4): coding agent v19 — conversation/events/workspace/
  // checkpoint/branch/plugins/plugin-config/presets/marketplace/agent (10) ---
  ...CODING_V19_TOOLS,
  // list/cancel (5) + permission evaluate/set/ask-resolve (3) +
  // oauth state/reconnect (2) + acp discover/session (2) = 12 ---
  ...PROTOCOL_V5_TOOLS,
  // --- v1.37 (Đội T2): protocols v6 — negotiate/versions (2) + acp
  // session/update/file-changes (3) + elicit form/url/modes (3) +
  // a2a stream start/send/control (3) + registry (1) = 12 ---
  ...PROTOCOL_V6_TOOLS,
  // --- v1.38 (Đội T2): protocols v7 — negotiate/versions (2) + a2a
  // card/task/client/server (4) + mcp stateless (1) + ucp catalog/
  // order (2) + govern delegate/escalate/audit (3) = 12 ---
  ...PROTOCOL_V7_TOOLS,
  // --- v1.39 (Đội T2): protocols v8 — discover/versions/extensions (3) +
  // stateless/legacy (2) + apps/tasks (2) + oauth/deprecation (2) + nanda/
  // server-card/skills (3) = 12 ---
  ...PROTOCOL_V116_TOOLS,
  // --- v1.40 (Đội T2): protocols v9 — versions (1) + apps/apps-lifecycle (2) +
  // acp detect/sessions/prompt (3) + a2a cards/tasks/messages/delegate (4) +
  // registry/snapshots (2) = 12 ---
  ...PROTOCOL_V117_TOOLS,
  // --- v1.41 (Đội T2): protocols v10 — versions (1) + stateless (1) + oauth (1) +
  // tool search/script (2) + tasks (1) + apps/apps-bridge (2) + roundtrip (1) +
  // a2a (1) + deprecation (1) + registry (1) = 12 ---
  ...PROTOCOL_V118_TOOLS,
  // --- v1.42 (Đội T2): protocols v11 — versions (1) + stateless (1) + discover (1) +
  // cache (1) + roundtrip (1) + tasks (1) + oauth (1) + interop (1) + apps (1) +
  // deprecation (1) + meta (1) + registry (1) = 12 ---
  ...PROTOCOL_V119_TOOLS,
  // --- v1.13 (Đội T5): voice v12 realtime (8) ---
  ...VOICE_V12_TOOLS,
  // --- v1.14 (Đội T5): voice v13 realtime (8) ---
  ...VOICE_V13_TOOLS,
  // --- v1.15 (Đội T5): voice v14 realtime (9) ---
  ...VOICE_V14_TOOLS,
  // --- v1.27 (Đội T5): voice v19 realtime — session manager /
  // prosody / eval / open-turn resume (13) ---
  ...VOICE_V19_TOOLS,
  // --- v1.29 (Đội T5): voice v20 extensions — persistence /
  // resume v2 / open-turn v8 / transcript accuracy / eval (8) ---
  ...VOICE_V20_TOOLS,
  // --- v1.34 (Đội T5): voice v21 realtime — voice-driven tool
  // calls, turn-taking, barge-in, eval, TTS cache, monitor (8) ---
  ...VOICE_V21_TOOLS,
  // --- v1.35 (Đội T5): voice v22 durable realtime — durable
  // session, barge-in v2, floor turn-taking, voice profiles,
  // recovery loop, durability monitor (6) ---
  ...VOICE_V22_TOOLS,
  // --- v1.36 (Đội T5): voice v23 eval + streaming + endpointing
  // v2, interruption v2, session manager v2, calibration +
  // device profiles, monitor panel v2 (7) ---
  ...VOICE_V23_TOOLS,
  // --- v1.37 (Đội T5): voice v24 — per-tool-call timers,
  // dynamic providers + health, mid-session model switch,
  // session, panel, report, fallback chains, budgets (9) ---
  ...VOICE_V24_TOOLS,
  // --- v1.38 (Đội T5): voice v25 — turn-level barge-in,
  // turn-taking + silence detection, real per-provider latency
  // + fallback, per-voice-turn timers, session, panel, report (7) ---
  ...VOICE_V25_TOOLS,
  // --- v1.39 (Đội T5): voice v26 — frame-level barge-in,
  // guarded turn-taking, latency budget + degraded mode,
  // expanded TTS/STT providers, session, live status + ui://, audio
  // simulation, report (8) ---
  ...VOICE_V26_TOOLS,
  // --- v1.40 (Đội T5): voice v27 — barge-in v2, VAD tuning +
  // turn-taking v2, multi-voice personas, durable session +
  // store, report (6) ---
  ...VOICE_V27_TOOLS,
  // --- v1.41 (Đội T5): voice v28 — mock realtime transport,
  // VAD hook, realtime session, memory-block voice style,
  // voice command routing, transcript + summary, multi-voice
  // casting, aggregate report (7) ---
  ...VOICE_V28_TOOLS,
  // --- v1.42 (Đội T4): voice v29 — full-duplex session, turn
  // detector, append-only context, delegated tools, proactive
  // audio, cascaded pipeline, per-minute cost (7) ---
  ...VOICE_V29_TOOLS,
  // --- v1.44 (Đội T4): voice v30 — full-duplex v2 session, turn
  // detector v2, two-lane duplex, barge-in v2, proactive audio v2,
  // cost ledger v2 (6) ---
  ...VOICE_V30_TOOLS,
  // --- v1.13 (Đội T6): fleet v10 (11) ---
  ...FLEET_V10_TOOLS,
  // --- v1.14 (Đội T4): Composio v114 — mock toolkits list/execute (2) +
  // poll schedule v2 (1) + connection health (1) + trigger templates (1) +
  // MCP App open (1) = 6 ---
  ...COMPOSIO_V114_TOOLS,
  // --- v1.18 (Đội T4): Composio v118 — mock toolkits list/execute (2) +
  // poll adaptive v5 (1) + trigger instances (1) + OAuth state (1) +
  // webhook ingest (1) = 6 ---
  ...COMPOSIO_V118_TOOLS,
  // --- v1.19 (Đội T4): Composio v119 — mock toolkits list/execute (2) +
  // poll batch v6 (1) + trigger instances v2 (1) + OAuth refresh v2 (1) +
  // webhook queue v2 (1) + toolkit prefs per-user (1) + usage metering (1) = 8 ---
  ...COMPOSIO_V119_TOOLS,
  // --- v1.29 (Đội T4): Composio v6 — long jobs submit/poll/get/list/
  // cancel (5) + mock toolkits list/execute (2) + sandbox create/
  // status (2) + app bind (1) = 10 ---
  ...COMPOSIO_V129_TOOLS,
  // --- v1.14 (Đội T6): fleet v11 (9) ---
  ...FLEET_V11_TOOLS,
  // --- v1.15 (Đội T3): local model router — catalogue list/validate (2) +
  // model load/unload/status (3) + route decide (1) + budget set/report (2) +
  // spend record (1) + gateway key (1) = 10 ---
  ...ROUTER_LOCAL_V115_TOOLS,
  // --- v1.39 (Đội T3): local model router v116 — score rank (1) +
  // policy profile list/set (2) + fallback run/status (2) +
  // CLI sources list/detect/set (3) + batch estimate/schedule (2) +
  // health probe (1) + picker list (1) + decision log (1) = 13 ---
  ...ROUTER_LOCAL_V116_TOOLS,
  // --- v1.40 (Đội T3): local model router v117 — mid-chat route (1) +
  // policy get/set (2) + tree set/get (2) + risk score (1) + annotate (1)
  // + tool-call gate (1) + confirm policy get/set (2) + pending (1) +
  // decide (1) + audit log (1) + cost report (1) + risk catalog (1) +
  // risk score batch (1) + confirm tool override (1) = 17 ---
  ...ROUTER_LOCAL_V117_TOOLS,
  // --- v1.41 (Đội T3): local model router v118 — tool_choice resolve (1) +
  // request params (1) + capability matrix (1) + toolset create/update (2) +
  // cache key (1) + thread lock (1) + script validate/run/audit (3) +
  // bot policy get/set (2) + cost route/report (2) + retry plan (1) = 15 ---
  ...ROUTER_LOCAL_V118_TOOLS,
  // --- v1.42 (Đội T5): router + provider v29 — catalog list/get/refresh (3) +
  // route (1) + architecture recommend (1) + cost record/report/budget (3) +
  // fallback plan/run (2) + health probe/summary (2) + provider config (1) +
  // cost forecast (1) + policy (1) = 15 ---
  ...ROUTER_V29_TOOLS,
  // --- v1.44 (Đội T5): router + provider v30 — catalog list/get/refresh/stale (4) +
  // route + route history (2) + latency record/stats (2) + fallback plan/run (2) +
  // health probe/summary (2) + CLI detect/list/consent/enable/label/invoke (6) +
  // budget set/report (2) + policy get/set (2) = 22 ---
  ...ROUTER_V30_TOOLS,
  // --- v1.15 (Đội T6): fleet v12 (9) ---
  ...FLEET_V12_TOOLS,
  // --- v1.18 (Đội T3): local-model router v3 — catalog/capability/cost/
  // rank/chat/local scan+status/cost set/circuit/latency (10) ---
  ...ROUTER_V3_TOOLS,
  // --- v1.33 (Đội T5): inference broker v2 — matrix (1) + route (1) +
  // probe (1) + probe status (1) + validate (1) + prefix cache (1) +
  // voice v22 status/turn (1) = 7 ---
  ...INFERENCE_BROKER_V2_TOOLS,
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
   * v1.34 (Đội T6): fleet v21 wiring. When given, the 18 fleet v21
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v3) — same 18 names, never a
   * duplicate. `getFleetV21State` resolves the host's live fleet state
   * (nodes + running runs + durable automation store + placement log);
   * without it the v21 tools answer "not configured".
   */
  getFleetV21State?: () => FleetV21ToolState | null | undefined;
  /**
   * v1.35 (Đội T6): fleet v22 wiring. When given, the 24 fleet v22
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v21) — same 24 names, never a
   * duplicate. `getFleetV22State` resolves the host's live fleet state
   * (user/computer/delegation registries + handoff agents + routing
   * rules + audit log + usage + probe); without it the v22 tools
   * answer "not configured".
   */
  getFleetV22State?: () => FleetV22ToolState | null | undefined;
  /**
   * v1.36 (Đội T6): fleet v23 wiring. When given, the 24 fleet v23
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v22) — same 24 names, never a
   * duplicate. `getFleetV23State` resolves the host's live fleet state
   * (topology + scheduler queue + node snapshots + placement + growth
   * + plans + history); without it the v23 tools answer
   * "not configured".
   */
  getFleetV23State?: () => FleetV23ToolState | null | undefined;
  /**
   * v1.37 (Đội T6): fleet v24 wiring. When given, the 26 fleet v24
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v23) — same 26 names, never a
   * duplicate. `getFleetV24State` resolves the host's live fleet state
   * (automation registry + run ledger + stop-hook feedback store +
   * CIDR rule set); without it the v24 tools answer "not configured".
   */
  getFleetV24State?: () => FleetV24ToolState | null | undefined;
  /**
   * v1.38 (Đội T6): fleet v25 wiring. When given, the 28 fleet v25
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v24) — same 28 names, never a
   * duplicate. `getFleetV25State` resolves the host's live fleet state
   * (user store + audit log + schedule registry + run ledger +
   * scheduler engine); without it the v25 tools answer
   * "not configured".
   */
  getFleetV25State?: () => FleetV25ToolState | null | undefined;
  /**
   * v1.39 (Đội T6): fleet v26 wiring. When given, the 34 fleet v26
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v25) — same 34 names, never a
   * duplicate. `getFleetV26State` resolves the host's live fleet state
   * (resource allocator + bot registry + shared blocks + skill pack +
   * hook registry + plugin registry + MCP Apps registry + admission
   * store); without it the v26 tools answer "not configured".
   */
  getFleetV26State?: () => FleetV26ToolState | null | undefined;
  /**
   * v1.40 (Đội T6): fleet v27 wiring. When given, the 30 fleet v27
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v26) — same 30 names, never a
   * duplicate. `getFleetV27State` resolves the host's live fleet state
   * (campaign store + automation store + quota store); without it the
   * v27 tools answer "not configured".
   */
  getFleetV27State?: () => FleetV27ToolState | null | undefined;
  /**
   * v1.41 (Đội T6): fleet v28 wiring. When given, the 40 fleet v28
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v27) — same 30 names, never a
   * duplicate. `getFleetV28State` resolves the host's live fleet state
   * (runtime store + secret store + budget store + preset store);
   * without it the v28 tools answer "not configured".
   */
  getFleetV28State?: () => FleetV28ToolState | null | undefined;
  /**
   * v1.42 (Đội T6): fleet v29 wiring. When given, the 33 fleet v29
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v28) — same 37 names, never a
   * duplicate. `getFleetV29State` resolves the host's live fleet state
   * (peer registry + allowlist + task board + audit log +
   * confirmation queue); without it the v29 tools answer "not configured".
   */
  getFleetV29State?: () => FleetV29ToolState | null | undefined;
  /**
   * v1.44 (Đội T6): fleet v30 wiring. When given, the 60 fleet v30
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as fleet v29) — same 52 names, never a
   * duplicate. `getFleetV30State` resolves the host's live fleet state
   * (isolation manager + board v2 + peer groups + admin policy on top
   * of the v29 registry/allowlist/board); without it the v30 tools
   * answer "not configured".
   */
  getFleetV30State?: () => FleetV30ToolState | null | undefined;
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
   * v1.12 (Doi T1): memory v12 wiring. When given, the 7 memory v12
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v11) — never registered twice.
   * `getMemoryV12WorkspaceDir` resolves the bot workspace dir
   * (memory blocks live there). `getMemoryV12BotId` resolves the
   * calling bot id (actor `agent:<botId>` for edit/audit checks).
   */
  getMemoryV12WorkspaceDir?: () => string | null | undefined;
  getMemoryV12BotId?: () => string | null | undefined;
  /**
   * v1.15 (Doi T1): memory v14 wiring. When given, the 8 memory v14
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v12) — never registered twice.
   * `getMemoryV14WorkspaceDir` resolves the bot workspace dir
   * (temporal graph lives there). `getMemoryV14BotId` resolves the
   * calling bot id (actor `agent:<botId>` for extract/erase checks).
   */
  getMemoryV14WorkspaceDir?: () => string | null | undefined;
  getMemoryV14BotId?: () => string | null | undefined;
  /**
   * v1.38 (Doi T1): memory v23 wiring. When given, the 10 memory v23
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v14) — never registered twice.
   * `getMemoryV23WorkspaceDir` resolves the bot workspace dir
   * (memory-v22.json + procedural-v22.json live there).
   * `getMemoryV23BotId` resolves the calling bot id (default scope
   * agentId cho record moi).
   */
  getMemoryV23WorkspaceDir?: () => string | null | undefined;
  getMemoryV23BotId?: () => string | null | undefined;
  /**
   * v1.39 (Doi T1): memory v24 wiring. When given, the 10 memory v24
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v23) — never registered twice.
   * `getMemoryV24WorkspaceDir` resolves the bot workspace dir
   * (memory-v24.json + memfs/ live there).
   * `getMemoryV24BotId` resolves the calling bot id (default scope
   * agentId cho record moi).
   */
  getMemoryV24WorkspaceDir?: () => string | null | undefined;
  getMemoryV24BotId?: () => string | null | undefined;
  /**
   * v1.40 (Doi T1): memory v25 wiring. When given, the 10 memory v25
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v24) — never registered twice.
   * `getMemoryV25WorkspaceDir` resolves the bot workspace dir
   * (memory-v25-store.json live there).
   * `getMemoryV25BotId` resolves the calling bot id (default scope
   * agentId cho record moi).
   */
  getMemoryV25WorkspaceDir?: () => string | null | undefined;
  getMemoryV25BotId?: () => string | null | undefined;
  /**
   * v1.41 (Doi T1): memory v26 wiring. When given, the 10 memory v26
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v25) — never registered twice.
   * `getMemoryV26WorkspaceDir` resolves the bot workspace dir
   * (memory-v26-store.json live there).
   * `getMemoryV26BotId` resolves the calling bot id (default scope
   * agentId cho record moi).
   */
  getMemoryV26WorkspaceDir?: () => string | null | undefined;
  getMemoryV26BotId?: () => string | null | undefined;
  /**
   * v1.42 (Doi T1): A2A v1.0 wiring. When given, the 10 A2A v11
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as memory v26) — never registered twice.
   * `getA2aV11ToolOptions` resolves the shared server / registry /
   * audit / local card for the bound tools.
   */
  getA2aV11ToolOptions?: () => import('./a2aV11Tools').A2aV11ToolOptions | null | undefined;
  /**
   * v1.42 (Doi T3): memory v27 wiring. When given, the 10 memory v27
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v26) — never registered twice.
   * `getMemoryV27WorkspaceDir` resolves the bot workspace dir
   * (memory-v27-store.json live there).
   * `getMemoryV27BotId` resolves the calling bot id (default scope
   * agentId cho record moi).
   */
  getMemoryV27WorkspaceDir?: () => string | null | undefined;
  getMemoryV27BotId?: () => string | null | undefined;
  /**
   * v1.44 (Doi T1): memory v28 wiring. When given, the 10 memory v28
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern as v27) — never registered twice.
   * `getMemoryV28WorkspaceDir` resolves the bot workspace dir
   * (memory v28 repo lives at `<dir>/memory-v28/`).
   * `getMemoryV28BotId` resolves the calling bot id (owner/ACL
   * identity cho shared block + sleep run).
   */
  getMemoryV28WorkspaceDir?: () => string | null | undefined;
  getMemoryV28BotId?: () => string | null | undefined;
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
   * v1.34 (Đội T2): Sandbox v2 wiring. When given, the 9 sandbox v2
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getSandboxV2BaseDir` resolves the app userData dir (per-run
   * workspaces live under `<userData>/sandbox-v2/`).
   */
  getSandboxV2BaseDir?: () => string | null | undefined;
  /** v1.34 (Đội T2): base dir override cho sandbox v2 tools. */
  getSandboxV2ToolOptions?: () => SandboxV2ToolOptions | undefined;
  /**
   * v1.35 (Đội T2): Sandbox v3 wiring. When given, the 15 sandbox v3
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getSandboxV3BaseDir` resolves the app userData dir (sessions
   * live under `<userData>/sandbox-v3/`, snapshots under
   * `<userData>/sandbox-v3/snapshots/`).
   */
  getSandboxV3BaseDir?: () => string | null | undefined;
  /** v1.35 (Đội T2): base dir override cho sandbox v3 tools. */
  getSandboxV3ToolOptions?: () => SandboxV3ToolOptions | undefined;
  /**
   * v1.36 (Đội T4): Sandbox v4 wiring. When given, the 19 sandbox v4
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getSandboxV4BaseDir` resolves the app userData dir (runtimes
   * live under `<userData>/sandbox-v4/conversations/<id>/`, v3
   * sessions under `<userData>/sandbox-v4/v3-sessions/`).
   */
  getSandboxV4BaseDir?: () => string | null | undefined;
  /** v1.36 (Đội T4): base dir override cho sandbox v4 tools. */
  getSandboxV4ToolOptions?: () => SandboxV4ToolOptions | undefined;
  /**
   * v1.37 (Đội T3): Sandbox v5 wiring. When given, the 22 sandbox v5
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getSandboxV5BaseDir` resolves the app userData dir (choices
   * under `<userData>/sandbox-v5/`, archives under
   * `<userData>/sandbox-v5/archives/`).
   */
  getSandboxV5BaseDir?: () => string | null | undefined;
  /** v1.37 (Đội T3): base dir override cho sandbox v5 tools. */
  getSandboxV5ToolOptions?: () => SandboxV5ToolOptions | undefined;
  /**
   * v1.38 (Đội T3): Sandbox v6 wiring. When given, the 22 sandbox v6
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getSandboxV6BaseDir` resolves the app userData dir (runtimes
   * live under `<userData>/sandbox-v6/bots/<botId>/`).
   */
  getSandboxV6BaseDir?: () => string | null | undefined;
  /** v1.38 (Đội T3): base dir override cho sandbox v6 tools. */
  getSandboxV6ToolOptions?: () => SandboxV6ToolOptions | undefined;
  /**
   * v1.34 (Đội T4): Eval Harness v2 wiring. When given, the 6 eval
   * harness v2 placeholders in ALL_TOOLS are replaced by bound tools
   * (same replace-in-place pattern) — never registered twice.
   * `getEvalHarnessV2BaseDir` resolves the app userData dir (tasks
   * `<userData>/eval-harness-v2-tasks`, baseline
   * `<userData>/eval-harness-v2/baseline.json`, reports
   * `<userData>/eval-harness-v2-reports/`).
   */
  getEvalHarnessV2BaseDir?: () => string | null | undefined;
  /** v1.34 (Đội T4): executor thật + plan scripted cho eval harness v2 tools. */
  getEvalHarnessV2ToolOptions?: () => EvalHarnessV2ToolOptions | undefined;
  /**
   * v1.35 (Đội T4): Eval Harness v3 wiring. When given, the 8 eval
   * harness v3 placeholders in ALL_TOOLS are replaced by bound tools
   * (same replace-in-place pattern) — never registered twice.
   * `getEvalHarnessV3BaseDir` resolves the app userData dir (tasks
   * `<userData>/eval-harness-v3-tasks`, baseline
   * `<userData>/eval-harness-v3/baseline.json`, reports
   * `<userData>/eval-harness-v3-reports/`, traces
   * `<userData>/eval-harness-v3-traces/`).
   */
  getEvalHarnessV3BaseDir?: () => string | null | undefined;
  /** v1.35 (Đội T4): executor thật + plan scripted cho eval harness v3 tools. */
  getEvalHarnessV3ToolOptions?: () => EvalHarnessV3ToolOptions | undefined;
  /**
   * v1.12 (Đội T2): event-sourced conversation wiring. When given,
   * the 11 conversation v112 placeholders in ALL_TOOLS are replaced
   * by bound tools (same replace-in-place pattern) — never registered
   * twice. `getConversationV112BaseDir` resolves the app userData dir
   * (logs `<userData>/conversations-v112/`).
   */
  getConversationV112BaseDir?: () => string | null | undefined;
  /** v1.12 (Đội T2): CodeAct executor + workspace fallback cho conversation v112 tools. */
  getConversationV112ToolOptions?: () => ConversationV112ToolOptions | undefined;
  /**
   * v1.14 (Đội T3): coding agent v6 wiring. When given, the 7 coding
   * v6 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV6BaseDir` resolves the app userData dir (logs
   * `<userData>/coding-v6/`).
   */
  getCodingV6BaseDir?: () => string | null | undefined;
  /** v1.14 (Đội T3): CodeAct executor + sub-agent runner + workspace fallback cho coding v6 tools. */
  getCodingV6ToolOptions?: () => CodingV6ToolOptions | undefined;
  /**
   * v1.15 (Đội T4): coding agent v7 wiring. When given, the 9 coding
   * v7 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV7BaseDir` resolves the app userData dir (logs
   * `<userData>/coding-v7/`).
   */
  getCodingV7BaseDir?: () => string | null | undefined;
  /** v1.15 (Đội T4): model generator + workspace fallback + skills dir cho coding v7 tools. */
  getCodingV7ToolOptions?: () => CodingV7ToolOptions | undefined;
  /**
   * v1.17 (Đội T4): coding agent v9 wiring. When given, the 6 coding
   * v9 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV9BaseDir` resolves the app userData dir (data dir
   * `<userData>/coding-v9/`).
   */
  getCodingV9BaseDir?: () => string | null | undefined;
  /** v1.17 (Đội T4): workspace fallback cho coding v9 tools. */
  getCodingV9ToolOptions?: () => CodingV9ToolOptions | undefined;
  /**
   * v1.18 (Đội T2): coding agent v10 wiring. When given, the 7 coding
   * v10 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV10BaseDir` resolves the app userData dir (data dir
   * `<userData>/coding-v10/`).
   */
  getCodingV10BaseDir?: () => string | null | undefined;
  /** v1.18 (Đội T2): workspace fallback cho coding v10 tools. */
  getCodingV10ToolOptions?: () => CodingV10ToolOptions | undefined;
  /**
   * v1.29 (Đội T3): coding agent v14 wiring. When given, the 6 coding
   * v14 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV14BaseDir` resolves the app userData dir (data dir
   * `<userData>/coding-v14/`).
   */
  getCodingV14BaseDir?: () => string | null | undefined;
  /** v1.29 (Đội T3): workspace fallback cho coding v14 tools. */
  getCodingV14ToolOptions?: () => CodingV14ToolOptions | undefined;
  /**
   * v1.37 (Đội T4): coding agent v15 wiring. When given, the 14 coding
   * v15 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV15BaseDir` resolves the app userData dir (data dir
   * `<userData>/coding-v15/`).
   */
  getCodingV15BaseDir?: () => string | null | undefined;
  /** v1.37 (Đội T4): workspace fallback cho coding v15 tools. */
  getCodingV15ToolOptions?: () => CodingV15ToolOptions | undefined;
  /**
   * v1.38 (Đội T4): coding agent v16 wiring. When given, the 7 coding
   * v16 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV16BaseDir` resolves the app userData dir (data dir
   * `<userData>/coding-v16/`).
   */
  getCodingV16BaseDir?: () => string | null | undefined;
  /** v1.38 (Đội T4): workspace fallback cho coding v16 tools. */
  getCodingV16ToolOptions?: () => CodingV16ToolOptions | undefined;
  /**
   * v1.39 (Đội T4): coding agent v17 wiring. When given, the 9 coding
   * v17 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV17BaseDir` resolves the app userData dir (data dir
   * `<userData>/coding-v17/`).
   */
  getCodingV17BaseDir?: () => string | null | undefined;
  /** v1.39 (Đội T4): workspace fallback cho coding v17 tools. */
  getCodingV17ToolOptions?: () => CodingV17ToolOptions | undefined;
  /**
   * v1.40 (Đội T4): coding agent v18 wiring. When given, the 8 coding
   * v18 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV18BaseDir` resolves the app userData dir (data dir
   * `<userData>/coding-v18/`).
   */
  getCodingV18BaseDir?: () => string | null | undefined;
  /** v1.40 (Đội T4): workspace fallback cho coding v18 tools. */
  getCodingV18ToolOptions?: () => CodingV18ToolOptions | undefined;
  /**
   * v1.41 (Đội T4): coding agent v19 wiring. When given, the 10 coding
   * v19 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getCodingV19BaseDir` resolves the app userData dir (data dir
   * `<userData>/coding-v19/`).
   */
  getCodingV19BaseDir?: () => string | null | undefined;
  /** v1.41 (Đội T4): workspace fallback cho coding v19 tools. */
  getCodingV19ToolOptions?: () => CodingV19ToolOptions | undefined;  /**
   * v1.29 (Đội T2): protocols v5 wiring. When given, the 12 protocol
   * v5 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. Host binds the
   * background-task runner, token provider, permission registry, auth
   * manager, ACP registry/client via ProtocolV5ToolOptions.
   */
  getProtocolV5ToolOptions?: () => ProtocolV5ToolOptions | undefined;
  /**
   * v1.37 (Đội T2): protocols v6 wiring. When given, the 12 protocol
   * v6 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. Host binds the
   * ACP v2 session engine / agent runner, file-change set, elicitation
   * manager and protocol registry via ProtocolV6ToolOptions.
   */
  getProtocolV6ToolOptions?: () => ProtocolV6ToolOptions | undefined;
  /**
   * v1.38 (Đội T2): protocols v7 wiring. When given, the 12 protocol
   * v7 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. Host binds the
   * card issuer / registry / trust store, task store / engine, A2A
   * server, MCP stateless server, UCP adapter, governance engine /
   * escalation queue / audit log via ProtocolV7ToolOptions; without
   * them the tools share fresh local in-memory instances.
   */
  getProtocolV7ToolOptions?: () => ProtocolV7ToolOptions | undefined;
  /**
   * v1.39 (Đội T2): protocols v8 wiring. When given, the 12 protocol
   * v8 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. Host binds the
   * MCP transport / stateless server, app registry, task engine,
   * deprecation tracker, NANDA registry / trust store and skill
   * registry via ProtocolV116ToolOptions; without them the tools
   * share fresh local in-memory instances.
   */
  getProtocolV116ToolOptions?: () => ProtocolV116ToolOptions | undefined;
  /**
   * v1.40 (Đội T2): protocols v9 wiring. When given, the 12 protocol
   * v9 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. Host binds the
   * app registry / lifecycle manager, ACP session manager, A2A card
   * registry and task store via ProtocolV117ToolOptions; without them
   * the tools share fresh local in-memory instances.
   */
  getProtocolV117ToolOptions?: () => ProtocolV117ToolOptions | undefined;
  /**
   * v1.41 (Đội T2): protocols v10 wiring. When given, the 12 protocol
   * v10 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. Host binds the
   * stateless server, search registry, task engine, app bridge and
   * deprecation registry via ProtocolV118ToolOptions; without them
   * the tools share fresh local in-memory instances.
   */
  getProtocolV118ToolOptions?: () => ProtocolV118ToolOptions | undefined;
  /**
   * v11 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. Host binds the
   * stateless server, task engine and list cache via ProtocolV119ToolOptions;
   * without them the tools share fresh local in-memory instances.
   */
  getProtocolV119ToolOptions?: () => ProtocolV119ToolOptions | undefined;
  /**
   * v1.29 (Đội T4): Composio v6 wiring. When given, the 10 Composio
   * v129 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. Host binds
   * the shared job/sandbox/binding stores + poll schedules + machine
   * defaults via ComposioV129ToolOptions so several turns share one
   * session state.
   */
  getComposioV129ToolOptions?: () => ComposioV129ToolOptions | undefined;
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
   * v1.12 (Đội T5): voice v11 wiring. When given, the 8 voice v11
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getVoiceV11Manager` returns the host's VoiceV11Manager (or
   * null when voice is not wired — the placeholders then refuse
   * with a plain message).
   */
  getVoiceV11Manager?: () => import('./voiceV11Tools').VoiceV11ManagerLike | null;
  /**
   * v1.29 (Đội T5): voice v19 wiring. When given, the 13 voice v19
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getVoiceV19Manager` returns the host's VoiceSessionManagerV19,
   * `getVoiceV19Prosody` its ProsodyControllerV19, `getVoiceV19TurnStore`
   * its OpenTurnStoreV19 (or null when voice is not wired).
   */
  getVoiceV19Manager?: () => import('@open-bot/core').VoiceSessionManagerV19 | null;
  getVoiceV19Prosody?: () => import('@open-bot/core').ProsodyControllerV19 | null;
  getVoiceV19TurnStore?: () => import('@open-bot/core').OpenTurnStoreV19 | null;
  /** v1.29 (Đội T5): session options for the default v19 manager. */
  getVoiceV19ToolOptions?: () => VoiceV19ToolOptions | undefined;
  /**
   * v1.29 (Đội T5): voice v20 wiring. When given, the 8 voice v20
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * The options carry the host's persistence store, resume
   * orchestrator, open-turn engine and eval harness accessors.
   */
  getVoiceV20ToolOptions?: () => VoiceV20ToolOptions | undefined;
  /**
   * v1.34 (Đội T5): voice v21 wiring. When given, the 8 voice v21
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * The options carry the host's session, tool-call engine,
   * turn machine, barge-in engine, eval harness, TTS cache and
   * monitor panel accessors.
   */
  getVoiceV21ToolOptions?: () => VoiceV21ToolOptions | undefined;
  /**
   * v1.35 (Đội T5): voice v22 wiring. When given, the 6 voice v22
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * The options carry the host's session, turn machine, barge-in
   * engine, profile registry, recovery engine, store, resume engine
   * and monitor panel accessors.
   */
  getVoiceV22ToolOptions?: () => VoiceV22ToolOptions | undefined;
  /**
   * v1.36 (Đội T5): voice v23 wiring. When given, the 7 voice v23
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * The options carry the host's harness, buffer, pacer,
   * endpointing engine, interruption policy/ledger, session
   * manager, calibration engine, device registry and panel
   * accessors.
   */
  getVoiceV23ToolOptions?: () => VoiceV23ToolOptions | undefined;
  /**
   * v1.37 (Đội T5): voice v24 wiring. When given, the 9 voice v24
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * The options carry the host's timer registry, dynamic
   * catalogue, health tracker and panel accessors.
   */
  getVoiceV24ToolOptions?: () => VoiceV24ToolOptions | undefined;
  /**
   * v1.38 (Đội T5): voice v25 wiring. When given, the 7 voice v25
   * tools are bound to the host's managers (barge-in, turn-taking,
   * turn timers, silence detector, latency tracker, panel accessors).
   */
  getVoiceV25ToolOptions?: () => VoiceV25ToolOptions | undefined;
  /**
   * v1.39 (Đội T5): voice v26 wiring. When given, the 8 voice v26
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * names, never a duplicate). The bound tools are wired to the
   * host's managers (barge-in detector, turn-taking machine,
   * latency budget, provider registry, status panel, sessions).
   */
  getVoiceV26ToolOptions?: () => VoiceV26ToolOptions | undefined;
  /**
   * v1.40 (Đội T5): voice v27 wiring. When given, the 6 voice v27
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * names, never a duplicate). The bound tools are wired to the
   * host's managers (interrupt policy, turn manager, persona
   * registry, durable store, sessions) and baseDir.
   */
  getVoiceV27ToolOptions?: () => VoiceV27ToolOptions | undefined;
  /**
   * v1.41 (Đội T5): voice v28 wiring. When given, the 7 voice v28
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * names, never a duplicate). The bound tools share one block
   * source (memory-block voice style) and one casting instance.
   */
  getVoiceV28ToolOptions?: () => VoiceV28ToolOptions | undefined;
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
   * v1.12 (Đội T6): fleet v9 wiring. When given, the 15 fleet v9
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getFleetV9BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`, automations state `<userData>/automations`,
   * MCP Apps state `<userData>/mcp-apps-v112.json`).
   * The 4 pure tools (day plan, automation dry-run, mock list/execute,
   * app catalogue) work even unbound.
   */
  getFleetV9BaseDir?: () => string | null | undefined;
  /**
   * v1.14 (Đội T6): fleet v11 wiring. When given, the 9 fleet v11
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getFleetV11BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`). The 4 pure tools (health snapshot, 3
   * panel view-models) work even unbound.
   */
  getFleetV11BaseDir?: () => string | null | undefined;
  /**
   * v1.15 (Đội T6): fleet v12 wiring. When given, the 9 fleet v12
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice.
   * `getFleetV12BaseDir` resolves the app userData dir (fleet root
   * is `<userData>/fleet`). The 3 pure tools (health dashboard,
   * 2 panel view-models) work even unbound.
   */
  getFleetV12BaseDir?: () => string | null | undefined;
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
  /**
   * v1.18 (Đội T3): router v3 wiring. When given, the 10 router v3
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. The getter
   * returns the router state the host owns (UnifiedRouterV3 +
   * fetch + apiKeys do host nap); tra null thi giu placeholder.
   */
  getRouterV3State?: () => RouterV3State | null | undefined;
  /**
   * v1.39 (Đội T3): local model router v116 wiring. When given, the 11
   * v116 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. The getter
   * returns the v116 state the host owns (scoring + fallback chain +
   * CLI sources + batching + health history); tra null thi giu
   * placeholder (default in-memory state).
   */
  getRouterLocalV116State?: () => RouterLocalV116State | null | undefined;
  /**
   * v1.40 (Đội T3): local model router v117 wiring. When given, the 17
   * v117 placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. The getter
   * returns the v117 state the host owns (mid-chat router + risk
   * scorer + confirmation gate); tra null thi giu placeholder
   * (default in-memory state).
   */
  getRouterLocalV117State?: () => RouterLocalV117State | null | undefined;
  /**
   * v1.41 (Đội T3): local model router v118 wiring. When given, the 15
   * router local v118 placeholders in ALL_TOOLS are replaced by bound
   * tools (same replace-in-place pattern) — never registered twice.
   * The getter returns the v118 state the host owns (tool sets +
   * audit + bot policies + ledger + executors); tra null thi giu
   * placeholder (default in-memory state).
   */
  getRouterLocalV118State?: () => RouterLocalV118State | null | undefined;
  /**
   * v1.42 (Đội T5): router v29 wiring. When given, the 15 router v29
   * placeholders in ALL_TOOLS are replaced by bound tools (same
   * replace-in-place pattern) — never registered twice. The getter
   * returns the v29 state the host owns (catalog + ledger + health
   * tracker + fallback chains); tra null thi giu placeholder
   * (default in-memory state).
   */
  getRouterV29State?: () => RouterV29State | null | undefined;
  /**
   * v1.44 (Đội T5): router + provider v30 wiring. When given, the 22
   * router v30 placeholders in ALL_TOOLS are replaced by bound tools
   * (same replace-in-place pattern) — never registered twice. The
   * getter returns the v30 state the host owns (versioned catalog +
   * latency stats + health tracker + fallback log + policy + CLI
   * consent/detections); tra null thi giu placeholder
   * (default in-memory state).
   */
  getRouterV30State?: () => RouterV30State | null | undefined;
  /**
   * v1.33 (Đội T5): inference broker v2 wiring. When given, the 7
   * broker v2 placeholders in ALL_TOOLS are replaced by bound tools
   * (same replace-in-place pattern) — never registered twice. The
   * getter returns the broker state the host owns (broker + fetch +
   * hasLiveKey); tra null thi giu placeholder.
   */
  getInferenceBrokerV2State?: () => InferenceBrokerV2State | null | undefined;
}): Tool[] {
  if (!opts?.getDaemon && !opts?.getCodingV19BaseDir && !opts?.getVoiceV28ToolOptions && !opts?.getProtocolV118ToolOptions && !opts?.getProtocolV119ToolOptions && !opts?.getEgressPolicy && !opts?.getInternetDataFile && !opts?.getBraveSearchApiKey && !opts?.onWatchChanged && !opts?.getFleetV103BaseDir && !opts?.getOpenmausbotV105BaseDir && !opts?.getEvalFleetV105BaseDir && !opts?.getPlatformV4BaseDir && !opts?.getMemoryV8WorkspaceDir && !opts?.getMemoryV9WorkspaceDir && !opts?.getMemoryV10WorkspaceDir && !opts?.getMemoryV11WorkspaceDir && !opts?.getMemoryV11BotId && !opts?.getMemoryV12WorkspaceDir && !opts?.getMemoryV12BotId && !opts?.getMemoryV14WorkspaceDir && !opts?.getMemoryV14BotId && !opts?.getMemoryV23WorkspaceDir && !opts?.getMemoryV23BotId && !opts?.getMemoryV24WorkspaceDir && !opts?.getMemoryV24BotId && !opts?.getMemoryV25WorkspaceDir && !opts?.getMemoryV25BotId && !opts?.getMemoryV26WorkspaceDir && !opts?.getMemoryV26BotId && !opts?.getMemoryV27WorkspaceDir && !opts?.getMemoryV27BotId && !opts?.getMemoryV28WorkspaceDir && !opts?.getMemoryV28BotId && !opts?.getA2aV11ToolOptions && !opts?.getSkillsPluginsV107Opts && !opts?.getFleetV4TeamsBaseDir && !opts?.getCodingV2WorkspaceDir && !opts?.getCodingV3WorkspaceDir && !opts?.getCodingV4WorkspaceDir && !opts?.getProvidersV108Opts && !opts?.getFleetV5BaseDir && !opts?.getAgentTeamsV109BaseDir && !opts?.getFleetV6BaseDir && !opts?.getFleetV7BaseDir && !opts?.getEvalV111BaseDir && !opts?.getConversationV112BaseDir && !opts?.getVoiceV10Manager && !opts?.hasVoiceV10LiveKey && !opts?.getVoiceV11Manager && !opts?.getFleetV8BaseDir && !opts?.getFleetV9BaseDir && !opts?.getCodingV6BaseDir && !opts?.getFleetV11BaseDir && !opts?.getCodingV7BaseDir && !opts?.getFleetV12BaseDir && !opts?.getCodingV9BaseDir && !opts?.getCodingV10BaseDir && !opts?.getCodingV14BaseDir && !opts?.getCodingV15BaseDir && !opts?.getCodingV16BaseDir && !opts?.getCodingV17BaseDir && !opts?.getCodingV18BaseDir && !opts?.getVoiceV19Manager && !opts?.getVoiceV19Prosody && !opts?.getVoiceV19TurnStore && !opts?.getVoiceV19ToolOptions && !opts?.getVoiceV20ToolOptions && !opts?.getVoiceV21ToolOptions && !opts?.getVoiceV22ToolOptions && !opts?.getVoiceV23ToolOptions && !opts?.getVoiceV24ToolOptions && !opts?.getVoiceV25ToolOptions && !opts?.getVoiceV26ToolOptions && !opts?.getVoiceV27ToolOptions && !opts?.getRouterV3State && !opts?.getRouterLocalV116State && !opts?.getRouterLocalV117State && !opts?.getRouterLocalV118State && !opts?.getRouterV29State && !opts?.getRouterV30State && !opts?.getComposioV129ToolOptions && !opts?.getInferenceBrokerV2State && !opts?.getFleetV21State && !opts?.getFleetV22State && !opts?.getFleetV23State && !opts?.getFleetV24State && !opts?.getFleetV25State && !opts?.getFleetV26State && !opts?.getFleetV27State && !opts?.getFleetV28State && !opts?.getFleetV29State && !opts?.getFleetV30State && !opts?.getEvalHarnessV2BaseDir && !opts?.getEvalHarnessV3BaseDir) return [...ALL_TOOLS];  let tools = [...ALL_TOOLS];  const idx = tools.indexOf(shellExecTool);  if (idx !== -1) {
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
  // v1.34 (Đội T6): bind the fleet v21 tools when the host wires them
  // (live fleet state). Same replace-in-place pattern as fleet v3 —
  // same 18 names, never a duplicate.
  if (opts?.getFleetV21State) {
    const bound = createFleetV21Tools(opts.getFleetV21State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.35 (Đội T6): bind the fleet v22 tools when the host wires them
  // (live fleet v22 state). Same replace-in-place pattern as fleet v21
  // — same 24 names, never a duplicate.
  if (opts?.getFleetV22State) {
    const bound = createFleetV22Tools(opts.getFleetV22State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.36 (Đội T6): bind the fleet v23 tools when the host wires them
  // (live fleet v23 state). Same replace-in-place pattern as fleet v22
  // — same 24 names, never a duplicate.
  if (opts?.getFleetV23State) {
    const bound = createFleetV23Tools(opts.getFleetV23State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.37 (Đội T6): bind the fleet v24 tools when the host wires them
  // (live fleet v24 state). Same replace-in-place pattern as fleet v23
  // — same 26 names, never a duplicate.
  if (opts?.getFleetV24State) {
    const bound = createFleetV24Tools(opts.getFleetV24State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.38 (Đội T6): bind the fleet v25 tools when the host wires them
  // (live fleet v25 state). Same replace-in-place pattern as fleet v24
  // — same 28 names, never a duplicate.
  if (opts?.getFleetV25State) {
    const bound = createFleetV25Tools(opts.getFleetV25State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.39 (Đội T6): bind the fleet v26 tools when the host wires them
  // (live fleet v26 state). Same replace-in-place pattern as fleet v25
  // — same 34 names, never a duplicate.
  if (opts?.getFleetV26State) {
    const bound = createFleetV26Tools(opts.getFleetV26State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.40 (Đội T6): bind the fleet v27 tools when the host wires them
  // (live fleet v27 state). Same replace-in-place pattern as fleet v26
  // — same 30 names, never a duplicate.
  if (opts?.getFleetV27State) {
    const bound = createFleetV27Tools(opts.getFleetV27State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.41 (Đội T6): bind the fleet v28 tools when the host wires them
  // (live fleet v28 state). Same replace-in-place pattern as fleet v27
  // — same 40 names, never a duplicate.
  if (opts?.getFleetV28State) {
    const bound = createFleetV28Tools(opts.getFleetV28State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.42 (Đội T6): bind the fleet v29 tools when the host wires them
  // (live fleet v29 state). Same replace-in-place pattern as fleet v28
  // — same 37 names, never a duplicate.
  if (opts?.getFleetV29State) {
    const bound = createFleetV29Tools(opts.getFleetV29State);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.44 (Đội T6): bind the fleet v30 tools when the host wires them
  // (live fleet v30 state). Same replace-in-place pattern as fleet v29
  // — same 60 names, never a duplicate.
  if (opts?.getFleetV30State) {
    const bound = createFleetV30Tools(opts.getFleetV30State);
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
  // same 24 names, never a duplicate). Without this opt the
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
  // v1.12 (Doi T1): bind the memory v12 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v11 —
  // same 9 names, never a duplicate. getMemoryV12BotId (optional)
  // sets the calling bot id for edit/audit actor checks.
  if (opts?.getMemoryV12WorkspaceDir) {
    const workspaceDir = opts.getMemoryV12WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV12BotId?.() ?? undefined;
      const bound = createMemoryV12Tools({ workspaceDir, ...(botId ? { botId } : {}) });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.15 (Doi T1): bind the memory v14 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v12 —
  // same 8 names, never a duplicate. getMemoryV14BotId (optional)
  // sets the calling bot id for extract/erase actor checks.
  if (opts?.getMemoryV14WorkspaceDir) {
    const workspaceDir = opts.getMemoryV14WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV14BotId?.() ?? undefined;
      const bound = createMemoryV14Tools({ workspaceDir, ...(botId ? { botId } : {}) });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.38 (Doi T1): bind the memory v23 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v14 —
  // same 10 names, never a duplicate. getMemoryV23BotId (optional)
  // sets the default scope agentId for new records.
  if (opts?.getMemoryV23WorkspaceDir) {
    const workspaceDir = opts.getMemoryV23WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV23BotId?.() ?? undefined;
      const bound = createMemoryV23Tools({ workspaceDir, ...(botId ? { botId } : {}) });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.39 (Doi T1): bind the memory v24 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v23 —
  // same 10 names, never a duplicate. getMemoryV24BotId (optional)
  // sets the default scope agentId for new records.
  if (opts?.getMemoryV24WorkspaceDir) {
    const workspaceDir = opts.getMemoryV24WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV24BotId?.() ?? undefined;
      const bound = createMemoryV24Tools({ workspaceDir, ...(botId ? { botId } : {}) });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.40 (Doi T1): bind the memory v25 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v24 —
  // same 10 names, never a duplicate. getMemoryV25BotId (optional)
  // sets the default scope agentId for new records.
  if (opts?.getMemoryV25WorkspaceDir) {
    const workspaceDir = opts.getMemoryV25WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV25BotId?.() ?? undefined;
      const bound = createMemoryV25Tools({ workspaceDir, ...(botId ? { botId } : {}) });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.41 (Doi T1): bind the memory v26 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v25 —
  // same 10 names, never a duplicate. getMemoryV26BotId (optional)
  // sets the default scope agentId for new records.
  if (opts?.getMemoryV26WorkspaceDir) {
    const workspaceDir = opts.getMemoryV26WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV26BotId?.() ?? undefined;
      const bound = createMemoryV26Tools({ workspaceDir, ...(botId ? { botId } : {}) });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.42 (Doi T1): bind the A2A v11 tools when the host wires them
  // (shared server / registry / audit / local card). Same
  // replace-in-place pattern as v26 — same 10 names, never a duplicate.
  if (opts?.getA2aV11ToolOptions) {
    const boundOpts = opts.getA2aV11ToolOptions();
    if (boundOpts) {
      const bound = createA2aV11Tools(boundOpts);
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.42 (Doi T3): bind the memory v27 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v26 —
  // same 10 names, never a duplicate. getMemoryV27BotId (optional)
  // sets the default scope agentId for new records.
  if (opts?.getMemoryV27WorkspaceDir) {
    const workspaceDir = opts.getMemoryV27WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV27BotId?.() ?? undefined;
      const bound = createMemoryV27Tools({ workspaceDir, ...(botId ? { botId } : {}) });
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.44 (Doi T1): bind the memory v28 tools when the host wires
  // them (bot workspace dir). Same replace-in-place pattern as v27 —
  // same 10 names, never a duplicate. getMemoryV28BotId (optional)
  // sets the owner/ACL identity for shared blocks + sleep runs.
  if (opts?.getMemoryV28WorkspaceDir) {
    const workspaceDir = opts.getMemoryV28WorkspaceDir();
    if (workspaceDir) {
      const botId = opts.getMemoryV28BotId?.() ?? undefined;
      const bound = createMemoryV28Tools({ workspaceDir, ...(botId ? { botId } : {}) });
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
  // v1.34 (Đội T2): bind the sandbox v2 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 9
  // names, never a duplicate.
  if (opts?.getSandboxV2BaseDir) {
    const bound = createSandboxV2Tools(
      opts.getSandboxV2BaseDir,
      opts.getSandboxV2ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.35 (Đội T2): bind the sandbox v3 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 15
  // names, never a duplicate.
  if (opts?.getSandboxV3BaseDir) {
    const bound = createSandboxV3Tools(
      opts.getSandboxV3BaseDir,
      opts.getSandboxV3ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.36 (Đội T4): bind the sandbox v4 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 19
  // names, never a duplicate.
  if (opts?.getSandboxV4BaseDir) {
    const bound = createSandboxV4Tools(
      opts.getSandboxV4BaseDir,
      opts.getSandboxV4ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.37 (Đội T3): bind the sandbox v5 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 22
  // names, never a duplicate.
  if (opts?.getSandboxV5BaseDir) {
    const bound = createSandboxV5Tools(
      opts.getSandboxV5BaseDir,
      opts.getSandboxV5ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.38 (Đội T3): bind the sandbox v6 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 22
  // names, never a duplicate.
  if (opts?.getSandboxV6BaseDir) {
    const bound = createSandboxV6Tools(
      opts.getSandboxV6BaseDir,
      opts.getSandboxV6ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.34 (Đội T4): bind the eval harness v2 tools when the host
  // wires them (userData dir). Same replace-in-place pattern — same 6
  // names, never a duplicate.
  if (opts?.getEvalHarnessV2BaseDir) {
    const bound = createEvalHarnessV2Tools(
      opts.getEvalHarnessV2BaseDir,
      opts.getEvalHarnessV2ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.35 (Đội T4): bind the eval harness v3 tools when the host
  // wires them (userData dir). Same replace-in-place pattern — same 8
  // names, never a duplicate.
  if (opts?.getEvalHarnessV3BaseDir) {
    const bound = createEvalHarnessV3Tools(
      opts.getEvalHarnessV3BaseDir,
      opts.getEvalHarnessV3ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.12 (Đội T2): bind the conversation v112 tools when the host
  // wires them (userData dir). Same replace-in-place pattern — same
  // 11 names, never a duplicate.
  if (opts?.getConversationV112BaseDir) {
    const bound = createConversationV112Tools(
      opts.getConversationV112BaseDir,
      opts.getConversationV112ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.14 (Đội T3): bind the coding v6 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 7 names, never a duplicate.
  if (opts?.getCodingV6BaseDir) {
    const bound = createCodingV6Tools(
      opts.getCodingV6BaseDir,
      opts.getCodingV6ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.15 (Đội T4): bind the coding v7 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 9 names, never a duplicate.
  if (opts?.getCodingV7BaseDir) {
    const bound = createCodingV7Tools(
      opts.getCodingV7BaseDir,
      opts.getCodingV7ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.17 (Đội T4): bind the coding v9 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 6 names, never a duplicate.
  if (opts?.getCodingV9BaseDir) {
    const bound = createCodingV9Tools(
      opts.getCodingV9BaseDir,
      opts.getCodingV9ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.18 (Đội T2): bind the coding v10 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 7 names, never a duplicate.
  if (opts?.getCodingV10BaseDir) {
    const bound = createCodingV10Tools(
      opts.getCodingV10BaseDir,
      opts.getCodingV10ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.29 (Đội T3): bind the coding v14 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 6 names, never a duplicate.
  if (opts?.getCodingV14BaseDir) {
    const bound = createCodingV14Tools(
      opts.getCodingV14BaseDir,
      opts.getCodingV14ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.37 (Đội T4): bind the coding v15 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 14 names, never a duplicate.
  if (opts?.getCodingV15BaseDir) {
    const bound = createCodingV15Tools(
      opts.getCodingV15BaseDir,
      opts.getCodingV15ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.38 (Đội T4): bind the coding v16 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 7 names, never a duplicate.
  if (opts?.getCodingV16BaseDir) {
    const bound = createCodingV16Tools(
      opts.getCodingV16BaseDir,
      opts.getCodingV16ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.39 (Đội T4): bind the coding v17 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 9 names, never a duplicate.
  if (opts?.getCodingV17BaseDir) {
    const bound = createCodingV17Tools(
      opts.getCodingV17BaseDir,
      opts.getCodingV17ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.40 (Đội T4): bind the coding v18 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 8 names, never a duplicate.
  if (opts?.getCodingV18BaseDir) {
    const bound = createCodingV18Tools(
      opts.getCodingV18BaseDir,
      opts.getCodingV18ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.41 (Đội T4): bind the coding v19 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same
  // 10 names, never a duplicate.
  if (opts?.getCodingV19BaseDir) {
    const bound = createCodingV19Tools(
      opts.getCodingV19BaseDir,
      opts.getCodingV19ToolOptions?.() ?? {},
    );
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.29 (Đội T2): bind the protocol v5 tools when the host wires
  // them (same replace-in-place pattern — same 12 names, never a duplicate).
  if (opts?.getProtocolV5ToolOptions) {
    const bound = createProtocolV5Tools(opts.getProtocolV5ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.37 (Đội T2): bind the protocol v6 tools when the host wires
  // them (same replace-in-place pattern — same 12 names, never a duplicate).
  if (opts?.getProtocolV6ToolOptions) {
    const bound = createProtocolV6Tools(opts.getProtocolV6ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.38 (Đội T2): bind the protocol v7 tools when the host wires
  // them (same replace-in-place pattern — same 12 names, never a duplicate).
  if (opts?.getProtocolV7ToolOptions) {
    const bound = createProtocolV7Tools(opts.getProtocolV7ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.39 (Đội T2): bind the protocol v8 tools when the host wires
  // them (same replace-in-place pattern — same 12 names, never a duplicate).
  if (opts?.getProtocolV116ToolOptions) {
    const bound = createProtocolV116Tools(opts.getProtocolV116ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.40 (Đội T2): bind the protocol v9 tools when the host wires
  // them (same replace-in-place pattern — same 12 names, never a duplicate).
  if (opts?.getProtocolV117ToolOptions) {
    const bound = createProtocolV117Tools(opts.getProtocolV117ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.41 (Đội T2): bind the protocol v10 tools when the host wires
  // them (same replace-in-place pattern — same 12 names, never a duplicate).
  if (opts?.getProtocolV118ToolOptions) {
    const bound = createProtocolV118Tools(opts.getProtocolV118ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.42 (Đội T2): bind the protocol v11 tools when the host wires
  // them (same replace-in-place pattern — same 12 names, never a duplicate).
  if (opts?.getProtocolV119ToolOptions) {
    const bound = createProtocolV119Tools(opts.getProtocolV119ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.29 (Đội T4): bind the Composio v129 tools when the host wires
  // them (same replace-in-place pattern — same 10 names, never a duplicate).
  if (opts?.getComposioV129ToolOptions) {
    const bound = createComposioV129Tools(opts.getComposioV129ToolOptions() ?? {});
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
  // v1.12 (Đội T5): bind the voice v11 tools when the host wires
  // them (same replace-in-place pattern — same 8 names, never a duplicate).
  if (opts?.getVoiceV11Manager) {
    const bound = createVoiceV11Tools({
      getManager: opts.getVoiceV11Manager,
    });
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.29 (Đội T5): bind the voice v19 tools when the host wires
  // them (same replace-in-place pattern — same 13 names, never a duplicate).
  if (opts?.getVoiceV19Manager || opts?.getVoiceV19Prosody || opts?.getVoiceV19TurnStore || opts?.getVoiceV19ToolOptions) {
    const bound = createVoiceV19Tools({
      ...(opts?.getVoiceV19Manager ? { getManager: opts.getVoiceV19Manager } : {}),
      ...(opts?.getVoiceV19Prosody ? { getProsody: opts.getVoiceV19Prosody } : {}),
      ...(opts?.getVoiceV19TurnStore ? { getTurnStore: opts.getVoiceV19TurnStore } : {}),
      ...(opts?.getVoiceV19ToolOptions ? { ...opts.getVoiceV19ToolOptions() } : {}),
    });
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.29 (Đội T5): bind the voice v20 tools when the host wires
  // them (same replace-in-place pattern — same 8 names, never a duplicate).
  if (opts?.getVoiceV20ToolOptions) {
    const bound = createVoiceV20Tools(opts.getVoiceV20ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.34 (Đội T5): bind the voice v21 tools when the host wires
  // them (same replace-in-place pattern — same 8 names, never a duplicate).
  if (opts?.getVoiceV21ToolOptions) {
    const bound = createVoiceV21Tools(opts.getVoiceV21ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.35 (Đội T5): bind the voice v22 tools when the host wires
  // them (same replace-in-place pattern — same 6 names, never a duplicate).
  if (opts?.getVoiceV22ToolOptions) {
    const bound = createVoiceV22Tools(opts.getVoiceV22ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.36 (Đội T5): bind the voice v23 tools when the host wires
  // them (same replace-in-place pattern — same 7 names, never a duplicate).
  if (opts?.getVoiceV23ToolOptions) {
    const bound = createVoiceV23Tools(opts.getVoiceV23ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.37 (Đội T5): bind the voice v24 tools when the host wires
  // them (same replace-in-place pattern — same 9 names, never a duplicate).
  if (opts?.getVoiceV24ToolOptions) {
    const bound = createVoiceV24Tools(opts.getVoiceV24ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.38 (Đội T5): bind the voice v25 tools when the host wires
  // them (same replace-in-place pattern — same 7 names, never a duplicate).
  if (opts?.getVoiceV25ToolOptions) {
    const bound = createVoiceV25Tools(opts.getVoiceV25ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.39 (Đội T5): bind the voice v26 tools when the host wires
  // them (same replace-in-place pattern — same 8 names, never a duplicate).
  if (opts?.getVoiceV26ToolOptions) {
    const bound = createVoiceV26Tools(opts.getVoiceV26ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.40 (Đội T5): bind the voice v27 tools when the host wires
  // them (same replace-in-place pattern — same 6 names, never a duplicate).
  if (opts?.getVoiceV27ToolOptions) {
    const bound = createVoiceV27Tools(opts.getVoiceV27ToolOptions() ?? {});
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.41 (Đội T5): bind the voice v28 tools when the host wires
  // them (same replace-in-place pattern — same 7 names, never a duplicate).
  if (opts?.getVoiceV28ToolOptions) {
    const bound = createVoiceV28Tools(opts.getVoiceV28ToolOptions() ?? {});
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
  // v1.12 (Đội T6): bind the fleet v9 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 15
  // names, never a duplicate.
  if (opts?.getFleetV9BaseDir) {
    const bound = createFleetV9Tools(opts.getFleetV9BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.14 (Đội T6): bind the fleet v11 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 9
  // names, never a duplicate.
  if (opts?.getFleetV11BaseDir) {
    const bound = createFleetV11Tools(opts.getFleetV11BaseDir);
    const boundNames = new Set(bound.map((t) => t.definition.name));
    const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
    if (firstIdx !== -1) {
      const kept = tools.filter((t) => !boundNames.has(t.definition.name));
      kept.splice(firstIdx, 0, ...bound);
      tools = kept;
    }
  }
  // v1.18 (Đội T3): bind the router v3 tools when the host wires
  // them (router state: apiKeys + fetch + config). Same
  // replace-in-place pattern — same 10 names, never a duplicate.
  // Without this opt the placeholders use the default state (no
  // keys: chat tra guidance, local scan dung global fetch).
  if (opts?.getRouterV3State) {
    const routerV3State = opts.getRouterV3State();
    if (routerV3State) {
      const bound = createRouterV3Tools(routerV3State);
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.39 (Đội T3): bind the router local v116 tools when the host
  // wires them (scoring + fallback + CLI sources + batching + health).
  // Same replace-in-place pattern — same 11 names, never a duplicate.
  if (opts?.getRouterLocalV116State) {
    const routerLocalV116State = opts.getRouterLocalV116State();
    if (routerLocalV116State) {
      const bound = createRouterLocalV116Tools(routerLocalV116State);
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.40 (Đội T3): bind the router local v117 tools when the host
  // wires them (mid-chat router + risk scorer + confirmation gate).
  // Same replace-in-place pattern — same 17 names, never a duplicate.
  if (opts?.getRouterLocalV117State) {
    const routerLocalV117State = opts.getRouterLocalV117State();
    if (routerLocalV117State) {
      const bound = createRouterLocalV117Tools(routerLocalV117State);
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.41 (Đội T3): bind the router local v118 tools when the host
  // wires them (tool sets + script audit + bot policies + ledger +
  // executors). Same replace-in-place pattern — same 15 names, never
  // a duplicate.
  if (opts?.getRouterLocalV118State) {
    const routerLocalV118State = opts.getRouterLocalV118State();
    if (routerLocalV118State) {
      const bound = createRouterLocalV118Tools(routerLocalV118State);
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.42 (Đội T5): bind the router v29 tools when the host wires
  // them (catalog + per-model cost ledger + health tracker +
  // fallback chains + provider configs + bot policies). Same
  // replace-in-place pattern — same 15 names, never a duplicate.
  if (opts?.getRouterV29State) {
    const routerV29State = opts.getRouterV29State();
    if (routerV29State) {
      const bound = createRouterV29Tools(routerV29State);
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.44 (Đội T5): bind the router v30 tools when the host wires
  // them (versioned catalog + latency stats + health tracker +
  // fallback log + policy + CLI consent/detections). Same
  // replace-in-place pattern — same 22 names, never a duplicate.
  if (opts?.getRouterV30State) {
    const routerV30State = opts.getRouterV30State();
    if (routerV30State) {
      const bound = createRouterV30Tools(routerV30State);
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.33 (Đội T5): bind the inference broker v2 tools when the host
  // wires them (broker state: broker + fetch + hasLiveKey). Same
  // replace-in-place pattern — same 7 names, never a duplicate.
  if (opts?.getInferenceBrokerV2State) {
    const brokerV2State = opts.getInferenceBrokerV2State();
    if (brokerV2State) {
      const bound = createInferenceBrokerV2Tools(brokerV2State);
      const boundNames = new Set(bound.map((t) => t.definition.name));
      const firstIdx = tools.findIndex((t) => boundNames.has(t.definition.name));
      if (firstIdx !== -1) {
        const kept = tools.filter((t) => !boundNames.has(t.definition.name));
        kept.splice(firstIdx, 0, ...bound);
        tools = kept;
      }
    }
  }
  // v1.18 merge fix round 1: restore the fleet v12 binding block that
  // v118-t3 accidentally deleted (it exists in base 063970db and in
  // every other v118 team branch; without it the 9 fleet_v12_* tools
  // stay placeholders and never bind to the host userData dir).
  // v1.15 (Đội T6): bind the fleet v12 tools when the host wires
  // them (userData dir). Same replace-in-place pattern — same 9
  // names, never a duplicate.
  if (opts?.getFleetV12BaseDir) {
    const bound = createFleetV12Tools(opts.getFleetV12BaseDir);
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
