# Repo survey v1.19 — Memory 2026 + Protocol 2026 (16/11/2026)

Nghiên cứu cho sóng v1.19. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Memory 2026

- **Mem0 v3 (04/2026)** — entity linking + hybrid retrieval (semantic + BM25 + entity). Hướng cho T1: extraction v2 ghi entity, retrieval kết hợp 3 tín hiệu thay vì chỉ vector.
- **Letta / MemGPT** — agent tự sửa memory blocks bằng tool; 3 tầng core / archival / recall; sleep-time compute (củng cố memory lúc rảnh). Hướng cho T1: blocks v3 có guardrail chống drift khi agent tự sửa; sleep-time consolidation v2.
- **Zep / Graphiti** — temporal knowledge graph, theo dõi cả thời điểm fact đúng trong thế giới lẫn thời điểm hệ thống học được nó (bi-temporal). Hướng cho T1: temporal KG bi-temporal v2.
- **Memory OS** (paper arXiv:2506.06326) — hệ điều hành memory cho agent.
- **OWASP ASI06** — memory/context poisoning: memory bị đầu độc rồi agent dùng lại như sự thật. Hướng cho T1: phòng chống poisoning (quarantine + provenance + scoring nguồn).
- **GDPR** — cần đường xoá (right to erasure) cho memory: xoá theo user, theo entity, theo khoảng thời gian, có audit trail.

## 2. Protocol 2026

- **MCP spec 2026-07-28** — core stateless: bỏ initialize handshake, per-request negotiation qua `_meta` + header `MCP-Protocol-Version`, server/discover mới, Multi Round-Trip Requests với `input_required`, Sampling/Roots/Logging deprecated, Tasks / MCP Apps / Skills-over-MCP thành extension, transport Streamable HTTP thay HTTP+SSE. Hướng cho T3: migration stateless core.
- **A2A v1.0 (12/03/2026)** — JSON-RPC/gRPC/HTTP+JSON, Agent Card có chữ ký; **v1.1 RC (10/2026)** — two-way streaming. Đã vào Agentic AI Foundation (Linux Foundation) 08/2026 cùng MCP.
- **AG-UI 1.0 (09/2026)**, **A2UI** declarative UI. Hướng cho T3: AG-UI 1.0 events + A2UI components.
- **Agent Skills, Open Responses, OpenEnv, OpenSandbox** gia nhập foundation 22/10/2026. Hướng cho T3: Agent Skills over MCP.

## 3. Nguồn

- dataaspirant.com/blog/mem0-vs-letta-vs-zep/
- codeyashu.github.io/study-planner/tracks/agentic-ai/memory-systems/
- danilchenko.dev/posts/mem0-vs-cognee-vs-letta/
- aiworkflowlab.dev/article/agent-memory-mem0-vs-letta-vs-zep-2026
- dev.to/gde/mcp-a2a-ucp-ap2-confused-a-simple-map-of-ai-agent-protocols-november-2026-3ph
- harnessrouter.ai/blog/ai-agent-protocols-2026
- hubagenticai.com/tutorials/agent-protocol-stack-mcp-a2a-ag-ui/

## 4. Áp dụng vào sóng v1.19

- T1 memory v18: Mem0-v3-style extraction + entity linking, hybrid retrieval, Letta blocks v3, temporal KG bi-temporal v2, chống poisoning, đường xoá GDPR, sleep-time consolidation v2, eval nhớ dài hạn kiểu LOCOMO chạy local.
- T3 protocols v3: MCP 2026-07-28 stateless core, A2A v1.1 two-way streaming, AG-UI 1.0, A2UI, Agent Skills over MCP, MCP Apps v3.
- Các đội khác (T2 coding v11, T4 Composio v4, T5 voice v18, T6 platform/fleet v16) tiếp tục theo roadmap sóng trước.
