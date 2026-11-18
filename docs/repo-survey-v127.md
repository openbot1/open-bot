# Repo survey v1.27 — 2026-11-17

Nghiên cứu phục vụ sóng v1.27. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. LangGraph 1.2.x — durable graph orchestration (langchain-ai/langgraph, ~43.800 stars, MIT)

- Agent = đồ thị có hướng gồm node/edge trên một state object chung; state là công dân hạng nhất.
- **Checkpointer sau mỗi super-step**: snapshot channel values + node chờ chạy tiếp; `thread_id` tách phiên.
  Checkpoint bền (SQLite/Postgres/Redis) → crash không mất tiến độ, process mới attach cùng
  `thread_id` và resume đúng super-step cuối. InMemorySaver chỉ dùng cho dev (mất khi restart).
- **Human-in-the-loop qua `interrupt()`**: checkpoint rồi trả quyền điều khiển; người duyệt/sửa
  xong graph resume đúng điểm đó — chờ được hàng giờ/ngày, vượt vòng đời process.
- **Time travel**: rewind về checkpoint cũ, replay, có thể sửa state trước khi chạy lại.
- Checkpoint tuple v4 ~8KB/super-step; cần prune checkpoint cũ, giữ thread ID < 255 ký tự.
- V1.0 (10/2025) đóng băng API graph lõi; 1.2.16 hiện hành (10/2026). Dùng production tại
  Klarna, Cisco, Vizient. Bài học số: recovery có checkpoint rẻ hơn retry mù — agent 20 bước
  crash ở bước 17 resume trong ~3 phút thay vì chạy lại toàn bộ; failure không phục hồi được
  ~1,7% trong cửa sổ 15 phút.
- **Đem vào open-bot**: T2 protocols v10 — runtime graph bền kiểu LangGraph: node/edge,
  checkpointer file/SQLite, interrupt/HITL trước hành động hệ quả, time-travel replay,
  thread-scoped runs; T1 memory v25 — session recall gắn checkpoint, memory xuyên phiên.

## 2. Browser agents — Stagehand v4, browser-use, Skyvern

- **Stagehand v4** (Browserbase, MIT, TS-first, trên Playwright): 4 primitive
  `act()` / `extract()` (Zod schema) / `observe()` / `agent()` — trộn code xác định
  (90% flow không đổi) với AI (10% hay vỡ). V4 (08/2026): browser-extension mode
  (logic chạy trong trình duyệt, giảm round-trip CDP), self-healing actions, result caching,
  báo nhanh ~2x Playwright, ít token hơn ~80%.
- **browser-use** (Python, MIT): agent tự chủ hoàn toàn — nhận goal, tự plan/navigate/click
  tới khi xong hoặc kẹt; dùng AXTree + Set-of-Mark vision.
- **Skyvern**: workflow + agent platform, vision + LLM, AGPL-style ở core.
- **AXTree + Set-of-Mark grounding** là mấu chốt tiết kiệm token: workflow 15 bước, DOM thô
  ~450.000 token (~$4,50) → AXTree distilled ~36.000 token (~$0,18–0,35).
- Tất cả Chromium-only (giới hạn của CDP stack). Stagehand = framework, không phải agent;
  browser-use = agent đầy đủ.
- **Đem vào open-bot**: T4 Composio v10 + browser agent — primitive act/extract/observe trên
  Playwright/CDP local, AXTree distillation, self-healing selector, cache kết quả, chạy
  trong sandbox BotBox; tích hợp Composio app như nguồn action cho browser agent.

## 3. OpenAI Agents SDK — primitives tối giản + Responses API

- SDK (Python `openai-agents` 0.24.0, JS `@openai/agents` 0.21.0, 10/2026; MIT; ~26.400 stars):
  4 primitive — Agents, Tools, Handoffs, Guardrails — cộng Sessions, Tracing, MCP,
  human approval, tool search, durable execution.
- **Handoff** = tool đặc biệt chuyển toàn bộ quyền điều khiển run sang specialist agent
  (khác agent-as-tool: agent con chạy subtask rồi trả về, agent gọi giữ quyền).
- **Responses API** là mặt phẳng chính cho agent dùng tool (thay Chat Completions);
  state phía server qua `previous_response_id`; 5 built-in tool: web search, file search,
  code interpreter, computer use, remote MCP server.
- **Assistants API đã sunset 26/08/2026**; Agent Builder + Evals shutdown 30/11/2026.
  **Agents API public beta 10/09/2026**: chạy agent trên managed Codex harness, OpenAI
  lưu tiến độ. AgentKit (DevDay 10/2025): Agent Builder, ChatKit, Connector Registry, eval loops.
- Provider-agnostic qua Any-LLM/LiteLLM adapter (beta, hành vi khác nhau theo provider);
  Responses-only tool bị drop trên backend Chat Completions.
- **Đem vào open-bot**: T2 protocols v10 — handoff giữa specialist agents trong runtime graph;
  T3 coding v18 — guardrails input/output quanh tool nguy hiểm; T6 platform v23 — session
  store + tracing kiểu Agents SDK cho fleet (local-first, không cloud).

## 4. Ưu tiên sóng v1.27

1. T2: durable graph runtime (checkpoint + interrupt + time travel) — lõi lớn nhất sóng này.
2. T4: browser agent primitives + Composio v10.
3. T1: memory v25 gắn checkpoint/session.
4. T3: coding agent v18 (eval + guardrails).
5. T5: voice v24.
6. T6: platform v23 + UI panels cho graph runs và browser agent.

## Nguồn

- https://blog.redlinesoft.net/posts/langgraph-stateful-graph-agent-orchestration/
- https://levelop.dev/blog/langgraph-ai-agent-framework-graph-orchestration
- https://tryinterlock.com/blog/langgraph-checkpoints-vs-retries-7-in-15-minutes.php
- https://ainanza.com/ai-tools/stagehand/
- https://www.browserbash.com/blog/stagehand-vs-browser-use-vs-skyvern
- https://teachaitools.blog/blog/autonomous-browser-agents-stagehand-browser-use-playwright-2026
- https://sidbharath.com/blog/openai-agents-sdk/
- https://agentsapis.com/chatgpt-agent-api/
- https://www.motiontic.com/glossary/openai-agents-sdk
