# Survey v1.41 — nghiên cứu 18/11/2026 (chu kỳ 23:01 +07)

Chỉ học Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. MCP spec 2026-07-28 — bản viết lại lớn nhất từ khi ra mắt
- Nguồn: medium.com/@nishara.ramasinghe (31/10/2026), vibecodeschool.com, aidaddy.tech.
- MCP nay thuộc Agentic AI Foundation (Linux Foundation), cùng goose và AGENTS.md; >300 thành viên (10/2026).
- **Stateless**: bỏ handshake `initialize` và header `Mcp-Session-Id`; mỗi request tự mang protocol version + capabilities trong `_meta`; server mới phải đáp `server/discover`. Server cần state thì tự phát handle, client truyền lại như tool argument thường.
- **Progressive tool discovery / Tool Search**: đánh dấu tool `defer_loading: true`, agent search tool khi cần thay vì load toàn bộ; Anthropic báo cáo giảm 85% token + chọn tool chính xác hơn trên thư viện tool lớn. Cực kỳ phù hợp open-bot: registry đã >1.100 tool.
- **Programmatic tool calling**: agent viết script gọi tool trong sandbox, chỉ kết quả cuối vào context.
- **Tasks extension**: công việc dài hạn tách khỏi core thành extension chính thức, có lifecycle.
- **MCP Apps** (extension chính thức 26/01/2026; GA cùng spec 28/07/2026): tool trả về UI resource `text/html;profile=mcp-app`, host render trong iframe sandbox trong cuộc trò chuyện; UI gọi lại MCP server qua JSON-RPC 2.0 over postMessage (`ui/initialize`, `tools/call`). Host launch: Claude, VS Code, ChatGPT, Goose; app đối tác: Figma, Slack, Asana, Box, Canva, Amplitude, Hex, monday.com, Clay. Mô hình bảo mật: UI không tin cậy, host làm trọng tài, backend là trust boundary; CSP build từ domain khai báo.
- **Bảo mật/Auth**: OAuth chặt hơn — validate token issuer (RFC 9207), token bound với server phát hành; Dynamic Client Registration deprecated, thay bằng explicit registration / Client ID Metadata Documents.
- **Deprecation policy**: tính năng deprecated tối thiểu 12 tháng mới được gỡ (90 ngày chỉ cho lỗi bảo mật active).
- **Multi Round-Trip Requests**: thay server-initiated request (sampling/elicitation callback) bằng kết quả `input_required`, client retry request gốc kèm đáp án.
- **Khác**: change notification gom vào 1 stream opt-in `subscriptions/listen`; Roots/Sampling/Logging deprecated; server nên list tool theo thứ tự deterministic để tăng cache hit; trace OpenTelemetry qua `_meta`.
- **A2A v1.0**: bổ sung cho MCP (tool-access), lo phối hợp agent-agent; từ 08/2026 cùng dưới Agentic AI Foundation.
- **Cạm bẫy provider 2026** (aidaddy.tech): Claude lớn (Fable/Mythos/Opus/Sonnet 5.5) trả 400 với `tool_choice: any/tool` (chỉ `auto`/`none`); beta `inline-tools-2026-09-15` cho đổi tool giữa hội thoại không phá prompt cache; API version `2026-10-21` bỏ `temperature/top_p/top_k` (400 cả khi để default); server-side threads đóng băng tool list (`thread_fingerprint_mismatch`).
- Ý tưởng cho v1.41: T2 protocols v10 — stateless MCP client (discover, không session), tool-search registry (defer_loading + search tool), Tasks extension lifecycle, MCP Apps UI resource (render panel trong chat), OAuth issuer validation.

## 2. Letta (MemGPT) — memory blocks tự quản
- Nguồn: sureprompts.com (2026), andrew.ooo (30/10/2026), agentopsguide.com (24/10/2026), danilchenko.dev, aiworkflowlab.dev (26/05/2026).
- Letta (trước là MemGPT, paper Berkeley 2023, arXiv 2310.08560) ~25.300 star, Apache 2.0; mã nguồn nay nằm trong Letta Code (npm), V1 API server về nhánh archive.
- Primitive chịu tải: **memory block** — chuỗi có label, nằm trong main context, agent tự sửa bằng tool call (`core_memory_append`, `core_memory_replace`). Block chuẩn: `human` (biết về user), `persona` (biết về chính mình); custom block cho task/project.
- Ba tầng: core memory (luôn trong context, vài trăm–vài nghìn token/block, buộc agent phải curate thay vì tích trữ) + archival memory (vector store, search khi cần) + recall memory (log hội thoại đầy đủ, query theo ngày/nội dung).
- **Shared memory blocks**: một block gắn cho nhiều agent (`block_ids`); một agent cập nhật, các agent khác thấy ngay — đáp án trực tiếp cho "agent chia sẻ memory thế nào". Letta được xếp tốt nhất cho live shared state giữa supervisor và worker.
- So sánh 2026: Mem0 = fact extraction + vector store nhanh nhất để gắn thêm; Zep/Graphiti = temporal knowledge graph cho fact thay đổi theo thời gian; Letta = agent tự quản memory, nặng nhưng là lựa chọn duy nhất cho agent chạy tự chủ nhiều ngày.
- Chi phí thật: nhiều token/turn hơn, loop chậm hơn vì agent tốn reasoning budget cho housekeeping memory.
- Ý tưởng cho v1.41: T1 memory v26 — shared memory blocks đa bot (một block, nhiều bot thấy ngay), block budget/curation (giới hạn token, agent tự tóm tắt khi đầy), archival search theo ngày, memory block versioning + audit ai sửa.

## 3. OpenHands SDK v1.60.1 / Agent Canvas v1.39.0 (11/11/2026)
- Nguồn: aistackcurrent.com (05/11/2026), stags.cn, docs.openhands.dev.
- Software Agent SDK tách riêng: Agent / Conversation (event-backed) / Workspace / Agent Server tách bạch; từ v1.49 mỗi conversation có thể chạy trong Docker runtime riêng có giới hạn, giữ nguyên API conversation.
- v1.47: OpenAI Responses gateway; v1.48: profile-scoped secrets, conversation-scoped runtime API, `AgentSandboxWorkspace`, redaction log/API-key mạnh hơn; v1.49.2: Agent Plugins `mcp.json`, package path containment; v1.49.5: idle Docker runtime eviction, persisted MCP wire compatibility.
- Canvas 1.38: conversation budget meters, editable executable plugin config, Paper theme, automation-aware install (`mode=automation` + POST /plugin-spec), prompt/plugin presets theo agent profile.
- Bài học vận hành: runtime image và host package phải nâng cùng lúc (1.60.1 vá CVE-2026-109518 trong Debian snapshot); container dừng khi Docker/Apptainer startup fail.
- Ý tưởng cho v1.41: T6 fleet v28 — per-conversation sandbox runtime (giới hạn CPU/RAM, evict khi idle), profile-scoped secrets (secret theo bot/profile, không global), conversation budget meter (token/$ theo phiên, hiển thị trong UI), plugin preset theo profile.

## 4. Hướng đội v1.41 (gợi ý, coordinator tự chốt sau khi grep phiên bản thật)
- T1 memory v26: shared memory blocks + curation/budget (theo §2).
- T2 protocols v10 + protocolV118: stateless MCP, tool search (defer_loading), Tasks extension, MCP Apps UI resource (theo §1).
- T3 router local v118: programmatic tool calling + tool_choice auto/none theo provider mới (theo §1 cạm bẫy), inline-tools mid-conversation.
- T4 coding agent v19: event-backed conversation + workspace tách bạch, Agent Plugins `mcp.json` (theo §3).
- T5 voice v28: realtime voice + memory block persona/human nói (giọng theo persona block).
- T6 platform/fleet v28: per-conversation sandbox runtime + profile-scoped secrets + budget meter (theo §3).

## 5. Bối cảnh sóng
- Base: merge/v140 @ 4ca225d6 = 923.570 dòng TS (đo lại 23:0x +07 18/11), i18n 8.579 key × 6 locale.
- Sóng v1.40 chỉ đạt +20.667 (69% sàn) vì mỗi đội ~2.500–4.100 TS thật. Sóng v1.41 PHẢI đặt mục tiêu mỗi đội ~5.500 TS thật (mở rộng scope thành 2 subsystem/đội nếu cần) để vượt sàn +30.000 — KHÔNG độn dòng, KHÔNG filler.
- Full suite v1.40 lần 4 đang chạy (bắt đầu 22:59 +07, dự kiến xong ~23:27 +07); coordinator v1.41 KHÔNG chạy build/suite nặng cho tới khi suite đó xong hẳn (kiểm tra `hidden_files/v140-fullsuite-r4.log` lấy SUITE4_EXIT).
