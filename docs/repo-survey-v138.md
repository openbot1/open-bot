# Repo survey v138 — nghiên cứu 18/11/2026 (chu kỳ 11:01)

CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
Nguồn: tìm kiếm web ngày 18/11/2026 (xem link cuối file).

## 1. Giao thức agent 2026: hợp nhất về 2 tầng (T2 — protocolsV7)

- **A2A v1.0** (03/2026, Linux Foundation / Agentic AI Foundation): chuẩn agent-to-agent
  ổn định đầu tiên; v1.0.1 (05/2026) bổ sung. >150 tổ chức hỗ trợ (04/2026).
  Agent Card ký JWS (từ v0.3) để xác minh danh tính; v1.0 thêm multi-protocol,
  multi-tenancy, đường migration cho người dùng sớm.
- **ACP (IBM) đã gộp vào A2A** (08/2025): ACP ngừng phát triển độc lập; khái niệm
  stateful/async task dài hạn được đóng góp sang A2A. Repo ACP lưu trữ, có guide
  migration. Kết luận: đừng đầu tư thêm vào ACP riêng — mọi thứ mới đi theo A2A.
- **MCP spec 2026-07-28**: HTTP stateless — không handshake, không session id,
  mọi request tự mô tả, route được tới bất kỳ instance nào. MCP về tay Linux
  Foundation (Agentic AI Foundation, 09/12/2025). >10.000 MCP server đã publish.
- **UCP v2026-08-25** (Google + Shopify + Stripe): catalog search, cart, identity
  linking, checkout, order management. **ACP (Agentic Commerce Protocol, OpenAI +
  Stripe, beta 2026-04-17)** là tầng tiền: delegated auth OAuth 2.0 + Delegate
  Payment API. Hướng đứng của Huy: BỎ thanh toán/tài khoản/cloud — nên T2 chỉ làm
  UCP dạng đọc (catalog/cart/order tra cứu, không chuyển tiền), KHÔNG chạm tiền.
- **Khoảng trống chung**: cả 5 giao thức đều thiếu tầng governance — delegation,
  constraint, revocation chấm 2/12; voting/dissent/human-escalation vắng mặt ở
  tất cả. Đây là chỗ open-bot làm tốt hơn chuẩn: delegation có thu hồi + leo
  thang lên người dùng.
- Ý tưởng cho T2: A2A v1.0.1 client/server hoàn chỉnh (agent card JWS verify,
  multi-tenancy, task lifecycle async dài hạn), MCP stateless-HTTP transport,
  UCP read-only adapter, governance layer (delegate/revoke/escalate) phủ lên trên.

## 2. Memory 2026: ba kiến trúc, lấy cái hay của cả ba (T1 — memory v23)

- **Mem0** (lớp memory gắn ngoài): pipeline extract → consolidate (add/update/
  delete/noise) → retrieve; search fusion 3 tín hiệu (semantic + BM25 + entity);
  đa scope user_id/agent_id/run_id. Số báo cáo 04/2026: LoCoMo 92.5, LongMemEval
  94.4, ~6.900 tokens/query (full-context ~26.000), temporal +29.6, multi-hop
  +23.1 so với bản trước.
- **Letta (MemGPT)**: memory là kiến trúc, không phải service phụ. Core memory
  blocks (persona/human) agent tự sửa bằng tool; archival memory (vector) +
  recall memory (lịch sử đầy đủ). **Sleep-time compute**: agent nền dọn dẹp/
  tổ chức lại memory lúc idle, không chiếm turn của người dùng.
- **Zep/Graphiti**: temporal knowledge graph — không chỉ fact mà cả *khi nào*
  fact đúng (bi-temporal đã có trong open-bot, đào sâu thêm).
- **CoALA** (Princeton/Google): 4 loại memory — working, episodic, semantic,
  **procedural** (kỹ năng/workflows/cách làm việc — dạng skills). Procedural
  memory là mảng open-bot chưa có: lưu workflow đã học thành skill tái dùng.
- Ý tưởng cho T1: Mem0-style extract/consolidate chạy local (embedder local),
  retrieval fusion 3 tín hiệu, sleep-time consolidation v2 (dọn block lúc idle),
  procedural memory — workflow thành công được ghi thành skill có version +
  đánh giá, multi-scope retrieval (user/agent/run).

## 3. Coding agent: harness mua token, không mua điểm (T4 — codingV16)

- Preprint 03/10/2026 "What Does a Harness Buy? Tokens, Mostly" (Liu & Han,
  Shandong Univ.; 8.032 trial, SWE-bench Verified 492 task, 5 model, 3 harness:
  Claude Code / OpenCode / mini-SWE-agent): đổi harness chỉ xê dịch điểm trong
  biên nhiễu (~5 điểm; rerun cùng harness cũng lật ~13% task khó), nhưng **chi
  phí/task chênh tới 3x**. Preamble call đầu: ~16.600 token (Claude Code) vs
  ~7.000 (OpenCode) vs 829 (mini-SWE-agent). HarnessTax (Berkeley Sky Lab +
  Arena, 7 model): cùng kết luận, chênh tới 5x.
- Ba quyết định giao diện có số đo (nghiên cứu Princeton/SWE-agent): cửa sổ file
  100 dòng (+5.3 điểm), chỉ giữ 5 tool-output gần nhất trong history (+3),
  edit tool có linter chặn thay đổi sai cú pháp (+3).
- Ý tưởng cho T4: token-budget meter + harness-cost estimator (đo chi phí/task
  theo từng harness, báo cáo chứ không chỉ pass rate), minimal-harness mode
  (vòng lặp bash-only, preamble gọn), file-window viewer, edit linter gate,
  history trimmer tự động, benchmark nội bộ đo cost/accuracy trade-off.

## 4. Voice realtime (T5 — voice v25)

- v137 đã gộp voice v24 (budgets + fallback chains + refresh scheduler).
- Ý tưởng nối tiếp: barge-in / interruption handling, turn-taking + silence
  detection, per-tool-call timers UI mở rộng sang voice turn, model picker
  provider động (đã có trong v24 — đo thêm latency thực tế từng provider,
  fallback khi provider chậm). Mock-only cho phần cần key/live chưa có.

## 5. Sandbox + Fleet (T3 sandbox v6, T6 fleetV25)

- v137 T3 (sandbox v5, per-bot runtime + reclaim + secret hẹp) và T1/T4 vẫn
  đang chạy — T3/T6 của v138 xây TIẾP trên kết quả đã gộp của v137, không làm
  trùng: sandbox v6 = cgroup v2 enforce thật (CPU/RAM/disk quota), audit mọi
  exec, secret scoping theo bot; fleet v25 = multi-user roles + audit log +
  scheduled automations v2 trên dashboard v24 đã gộp.
- Lưu ý OOM 18/11: build sau gộp T6 của v137 bị kill (exit 137, RAM còn 303MB
  do 3 tsc chạy song song) — v138 staggered build, không chạy nhiều tsc cùng
  lúc, không chạy full suite khi suite khác đang chạy.

## 6. Tham chiếu đứng (từ các survey trước, vẫn hiệu lực)

- OpenMausBot (kiến trúc chính: CLI-agent auto-detect, harness local, Composio),
  OpenManus, OpenHands, Letta, mem0, Aider, hệ sinh thái MCP, pattern
  Claude Code/Copilot, giao thức agent mới. Học ý tưởng, không copy.

## Nguồn (truy cập 18/11/2026)

- https://tyk.io/learning-center/agent-protocols-a-complete-guide-to-mcp-a2a-and-acp/
- https://www.eggknite.com/blog/agent-protocol-standards-mcp-a2a-ucp
- https://www.agenticfabriq.com/blog/agent-protocol-stack-2026
- https://dataaspirant.com/blog/mem0-vs-letta-vs-zep/
- https://aiworkflowlab.dev/article/agent-memory-mem0-vs-letta-vs-zep-2026
- https://www.danilchenko.dev/posts/mem0-vs-cognee-vs-letta/
- https://anhtu.dev/long-term-memory-for-ai-agents-mem0-letta-zep-memory-augmented-llm-2026-2247
- https://www.reactify-solutions.com/articles/ai-agent-memory-systems-2026
- https://codingwithvibe.com/coding-agent-harness-cost-not-accuracy/
- https://dheerajakula.dev/blog/what-is-an-agent-harness-claude-code-codex-opencode
