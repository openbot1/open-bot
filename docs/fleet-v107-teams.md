# Platform/fleet v4 — v1.07 (Đội T6)

Agent Teams peer điều phối + subagent worktree isolation + router biết
context window từng model + prompt-cache theo hash cho memory blocks đã
biên dịch. Ý tưởng học từ Claude Code Agent Teams / subagent context
firewall / context 1M và OpenHands prompt caching (xem
`docs/repo-survey-v107.md` §1–§2) — chỉ học ý tưởng, không copy code.

## 1. Agent Teams — `packages/core/src/fleet/agentTeams.ts`

Team peer có điều phối viên, mỗi member sở hữu một workstream (lát cắt
không chồng nhau). Chạy theo sóng topo theo `dependsOn`; workstream
phụ thuộc vào workstream thất bại thì bị skip có lý do; một member lỗi
không kéo sập team. Điều phối viên gom kết quả thành báo cáo markdown.

- `createAgentTeam(input)` — validate: coordinator phải có role
  coordinator, owner phải tồn tại, một member chỉ sở hữu một lát cắt,
  slice chồng nhau → throw.
- `ownedSlicesOverlap(a, b)` — chồng khi bằng nhau hoặc một cái là tiền
  tố đường dẫn của cái kia (`a/b` chồng `a/b/c`).
- `runAgentTeam(team, runner, { concurrency })` — runner do caller tiêm
  (agent thật / CLI / mock); trả `{ team, report }`.
- Persistence: `<fleetRoot>/agent-teams-v107.json` (atomic write).

## 2. Subagent worktree isolation — `packages/core/src/subagents/worktreeIsolation.ts`

Context firewall: child làm trên worktree riêng, trả về tên branch.
Parent chỉ nhận envelope nén — không nhận hàng trăm tool call thô.

- `planWorktree({ repoRoot, branch, baseBranch?, worktreeParent? })` —
  validate tên branch theo luật git, worktree là thư mục anh em nằm
  NGOÀI repo root (worktree lồng → throw).
- `createWorktree / removeWorktree / listWorktrees(executor, …)` — git
  chạy qua executor tiêm vào (test dùng giả lập, không spawn thật).
- `summarizeToolCalls(calls)` — nén thành bảng đếm theo tool.
- `detectPathEscape(calls, worktreePath)` — liệt kê path child chạm
  ngoài worktree.
- `buildReturnEnvelope({ plan, status, summary, artifacts, toolCalls, … })`
  + `formatReturnEnvelope(envelope)` — thứ duy nhất parent nhận.

## 3. Router biết context window — `packages/core/src/router/contextWindow.ts`

Nối tiếp `targets.ts` (`ESTIMATED_CONTEXT_LIMIT` theo provider) xuống
mức model: khớp chính xác → họ model → provider mặc định → fallback
128k. Mọi số đều là ƯỚC TÍNH công khai, chỉ dùng để chọn chiến lược.

- `resolveContextWindow(model, providerId)` → `{ windowTokens, source }`.
- `assessContextPressure({ usedTokens, windowTokens, reserveTokens })` —
  đo trên window khả dụng (window − reserve): <70% `none`, 70–85%
  `summarize-oldest`, 85–95% `compress`, ≥95% `truncate-hard`.
- `planContextBudget(windowTokens)` — chia system 12% / memory 20% /
  reserve / history, tổng bằng window.
- `suggestLargerWindowTarget(current, candidates)` — gợi ý đích window
  lớn hơn ≥25% khi đã phải cắt cứng (đổi model rẻ hơn cắt mạch hội thoại).
- `assessTurnContext(target, usedTokens, candidates)` — gộp cả ba cho một turn.

## 4. Prompt-cache theo hash — `packages/core/src/context/promptCache.ts`

Nối tiếp `memory/promptRecompile.ts` (cache block trong bộ nhớ) thêm
cache cấp prompt + send plan + persistence.

- `CompiledPromptCache.compile(blocks, { providerId? })` → `{ compiled,
  plan, fullHit }`. Prompt không đổi → full HIT, không gửi lại gì.
- `buildSendPlan(compiled, previousPromptHash, providerId)` — lần đầu
  hoặc đổi quá nửa số section → gửi đủ; còn lại chỉ gửi section đổi +
  label không đổi. Token ước tính = ký tự / 4.
- `diffCompiledPrompts(previous, current)` — changed / added / removed /
  unchanged (hàm thuần, không cần instance).
- Persistence: `<baseDir>/compiled-prompt-cache-v107.json`
  (`savePromptCache` / `loadPromptCache`, atomic write; file hỏng → throw).

## Tool — `packages/tools/src/fleetV4TeamsTools.ts`

5 tool trong `ALL_TOOLS` (registry 389 → 394):

| Tool | Ghi chú |
| --- | --- |
| `fleet_v4_team_create` | Tạo team (cần approval, ghi file) |
| `fleet_v4_team_status` | Trạng thái team (chỉ đọc) |
| `fleet_v4_team_worktree` | Lập kế hoạch worktree — CHỈ PLAN, không chạy git; chạy cả khi chưa bind |
| `fleet_v4_context_strategy` | Chiến lược context cho model + token đã dùng; chạy cả khi chưa bind |
| `fleet_v4_prompt_cache` | stats / invalidate / clear cache prompt đã biên dịch |

## i18n

12 key `fleetV4Teams.*` × 6 locale (3565 key/locale).

## Test

- `tests/fleet-agent-teams-v107.test.mjs` — điều phối team chia workstream
- `tests/subagent-worktree-v107.test.mjs` — worktree isolation trả branch
- `tests/router-context-window-v107.test.mjs` — chiến lược nén theo context window
- `tests/prompt-cache-v107.test.mjs` — cache hit/miss theo hash
- `tests/fleet-v107-tools.test.mjs` — 5 tool + registry

## Giới hạn còn lại

- Worktree isolation chỉ cô lập cây làm việc git, không thay sandbox/quyền.
- Số context window là ước tính công khai — provider đổi window thì sửa
  bảng `KNOWN_MODEL_CONTEXT_WINDOWS` một chỗ.
- Team runner thật (agent/CLI) do host tiêm — module chỉ điều phối + gom kết quả.
- Prompt-cache lưu trong userData dir; token tiết kiệm là ước tính (ký tự/4).
