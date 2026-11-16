# Repo survey — sóng v1.17 (16/11/2026)

Nghiên cứu nhanh (~15 phút) trước sóng v1.17. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Memory: Mem0 vs Letta vs Zep — 2026

Nguồn: aiworkflowlab.dev, dataaspirant.com, danilchenko.dev, past.dev, codeyashu.github.io (so sánh 2026).

- **Mem0 v3 (04/2026):** LLM trích xuất fact từ hội thoại → vector store (+ graph tuỳ chọn); pipeline 2 bước: extraction rồi consolidation (add / update / delete / drop theo từng fact); scope theo `user_id` / `agent_id` / `run_id`; bản 2026 thêm entity linking + graph nhẹ. Claim LOCOMO: +26% accuracy vs OpenAI memory, p95 latency −91%, token −90% so với nhét full history.
- **Letta (MemGPT, arXiv 2310.08560):** agent tự quản lý memory bằng tool: core memory blocks (persona, human — luôn trong context, agent tự `core_memory_replace/append`), archival memory (vector store, tìm theo nhu cầu), recall memory (lịch sử theo ngày/nội dung). Block có thể share giữa các agent, có read-only. **Sleep-time agents:** agent nền rà soát hội thoại gần đây, consolidate và cập nhật memory ngoài vòng lặp chính — trigger sau N bước hoặc khi context bị compact.
- **Zep / Graphiti:** temporal knowledge graph — fact có validity window, supersession link, theo dõi fact thay đổi theo thời gian. Mạnh cho CRM/support.
- **Memory OS (arXiv:2506.06326):** tiered, OS-inspired agent memory, kết quả LoCoMo.
- **Rủi ro mới:** OWASP ASI06 Memory & Context Poisoning — memory bị đầu độc qua nội dung độc hại trong hội thoại/tài liệu. open-bot cần: memory quarantine, provenance (nguồn của mỗi fact), xác thực trước khi đưa fact vào core block.

**Áp vào v1.17 (T1 memory v16):** sleep-time consolidation agent (chạy nền sau mỗi phiên, gom fact → core/archival), Mem0-style consolidation 4 thao tác (add/update/delete/drop) với entity linking, memory poisoning guard (quarantine + provenance + allowlist nguồn), validity window cho fact (học Zep).

## 2. Coding agent: Aider / OpenHands / Claude Code — 2026

Nguồn: lordorange.top, mtechresearch.tech, fp8.co, dev.to.

- **Vòng lặp chung 5 tầng:** agent loop → context engineering → tool dispatch → edit strategy → safety. Context engineering là điểm khác biệt chính (repo map, indexing, compaction, file-scoping).
- **Aider:** git-first, mỗi edit = 1 commit atomic + message; repo map bằng tree-sitter (class/function signature + import, không thân hàm) nén cả repo lớn xuống vài nghìn token; edit kiểu search-and-replace block (ít token hơn full-file); **Architect–Editor pattern:** 2 model — planner mạnh lập kế hoạch, editor rẻ thực thi; hỗ trợ 75+ provider qua litellm, Ollama local (qwen2.5-coder 32B+); SWE-bench Verified architect mode 31,4%.
- **OpenHands (ex-OpenDevin):** Editor + Shell + Browser là tool hạng nhất, chạy trong sandbox/microVM; plan → edit → run test → lặp; commit + mở draft PR tự động; SWE-bench Verified ~72% với frontier model (open-source tốt nhất hiện tại); cần Docker.
- **Claude Code:** long-context grounding qua Projects + Artifacts (working surface bền, nhìn được trạng thái làm việc); apply-diff workflow, dev review trước khi áp; allowlist + approval prompt; multi-agent: Tab (completion nhanh) + Cmd+K (edit) + Composer (multi-file) + background agents.
- **Xu hướng:** plan-then-execute, multi-agent song song; edit strategies: whole-file / search-replace / structured diff / AST-aware.

**Áp vào v1.17 (T4 coding agent v9):** Architect–Editor 2-model (planner/editor tách bạch, editor có thể là model local rẻ), repo map v4 (tree-sitter + PageRank, nén token), AST-aware edit (thay vì whole-file), sandbox execution loop kiểu OpenHands (edit → test → lặp, tối đa N vòng), draft-PR/commit tự động theo kiểu Aider (git-first, atomic commit + message), SWE-bench-style eval harness nội bộ (đo pass@k trên task mẫu).

## 3. Giao thức agent 2026: MCP / A2A / AG-UI / A2UI / MCP Apps / UHP

Nguồn: harnessrouter.ai, profdrmafya.medium.com, getmaxim.ai, dev.to (11/2026).

- **Bản đồ ranh giới (không cạnh tranh nhau, là các tầng):** MCP = agent ↔ tool/data; A2A = agent ↔ agent độc lập; AG-UI/A2UI = agent backend ↔ UI người dùng; UCP = agent ↔ cửa hàng; AP2/x402 = thanh toán (ngoài phạm vi open-bot — Huy đã bỏ payments).
- **MCP spec 2026-07-28:** thay đổi lớn nhất — từ stateful session-based sang **stateless request/response**; ~97 triệu download/tháng (03/2026), tăng 970× trong 18 tháng; quản trị bởi Agentic AI Foundation (Linux Foundation).
- **A2A v1.0 (12/03/2026):** JSON-RPC, gRPC, HTTP+JSON; Agent Card discovery, delegate task, artifact output; 150+ tổ chức hỗ trợ; vào Agentic AI Foundation 08/2026; **v1.1 RC (cuối 10/2026): two-way streaming trong khi task chạy.** IBM ACP đã merge vào A2A (08/2025) — làm mới theo A2A, không theo ACP.
- **Ba cách làm UI cho agent:** AG-UI (event stream hai chiều backend ↔ app), A2UI (declarative, client-rendered generative UI), MCP Apps (MCP extension ổn định — server cung cấp interactive UI resource cho host). Ba cái chồng lấn nhưng hợp đồng khác nhau — có thể dùng chung trong một sản phẩm.
- **UHP:** chuẩn trẻ cho configured-harness boundary — cấu hình harness (model, skills, MCP server, tool restriction) và điều khiển qua task/session/streaming/file/cancel.
- **Số liệu:** tiếp cận layered (MCP + A2A) giảm ~60–70% độ phức tạp tích hợp so với ad-hoc (unified TLAS framework, 06/2026).

**Áp vào v1.17 (T2 protocol v2 / T3 router):** A2A v1.0 client+server nội bộ (Agent Card, task delegate, artifact; chuẩn bị two-way streaming kiểu v1.1 RC), MCP client cập nhật theo spec stateless 2026-07-28 (không giữ session state cũ), AG-UI event stream v2 + A2UI declarative renderer + MCP Apps UI resource (3 lớp UI hợp nhất trong một renderer), UHP-style harness config (model/skills/MCP/restriction trong một manifest, có cancel/streaming/file).

## 4. Hướng sóng v1.17 (6 đội, mục tiêu +30.000 dòng TS thật)

- **T1 — memory v16:** sleep-time consolidation, Mem0-style consolidation 4 thao tác + entity linking, validity window, poisoning guard (quarantine/provenance).
- **T2 — protocol v2:** A2A v1.0 (Agent Card, delegate, artifact, streaming), MCP stateless 2026-07-28, AG-UI v2 + A2UI + MCP Apps UI hợp nhất, UHP harness manifest.
- **T3 — router + local model v2:** Architect–Editor routing (planner mạnh / editor local rẻ), repo map v4 (tree-sitter + PageRank nén token), Ollama/LM Studio auto-detect mở rộng.
- **T4 — coding agent v9:** AST-aware edit, sandbox execution loop (edit → test → lặp), git-first atomic commit, eval harness kiểu SWE-bench nội bộ.
- **T5 — voice v16:** realtime v4 (speech-to-speech, barge-in, semantic turn-taking — nối tiếp v15), wake-word v4, TTS streaming v2.
- **T6 — platform/fleet v14 + UI:** multi-user v3, rollout v3, Composio polling v4, fleet v14, panels cho memory/protocol/coding-agent mới.

Quy tắc đứng: không copy code, không độn dòng, test cho mọi tính năng, build+typecheck xanh 4 workspace, full suite xanh dưới xvfb-run.
