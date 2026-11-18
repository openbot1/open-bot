# Repo survey v1.31 — 2026-11-17

Nghiên cứu phục vụ sóng v1.31. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Google ADK 2.0 — Workflow Runtime + session bền (google/adk, Apache 2.0)

- ADK 2.0 (Python GA 19/05/2026, Go 30/06/2026, TypeScript 21/08/2026) bỏ mô hình agent
  template 1.x (Sequential/Loop) sang **Workflow Runtime**: agent, tool, function đều là node
  trong một graph có routing động, fan-out/fan-in, loop, retry, human-in-the-loop, workflow lồng nhau.
- **Ngữ cảnh agent chia 5 cấu trúc theo lifetime**: Session (một thread hội thoại + event +
  state, bền qua DatabaseSessionService, mất khi restart nếu in-memory), State (key-value
  với prefix `user:`/`app:`/`temp:` — `temp:` bị xóa sau mỗi invocation), Memory (archive
  tìm kiếm được qua MemoryService, xuyên session), Artifact, Compaction/Caching.
- **Durable state machine thay cho dump history**: workflow dài ngày (onboarding 2 tuần,
  chờ vendor ký) được mô hình bằng schema state tường minh — agent lưu đúng bước hiện tại
  vào session bền (SQLite local / Cloud SQL), webhook đến thì tỉnh dậy và resume đúng chỗ,
  kill server giữa chừng rồi restart cũng không mất state, không hallucinate bước.
- **Event-driven dormancy thay polling**: chờ phê duyệt nhiều giờ/ngày bằng gate chờ sự kiện,
  không giữ thread, không poll. `ToolConfirmation` (còn experimental, có lỗ hổng với
  database persistence) — hành động phá hủy/tài chính cần thêm lớp audit + resumption ngoài.
- Multi-agent = cây phân cấp tường minh: parent delegate cho child agent, mỗi child có tool
  + instruction riêng; song song (parallel workflow) và tuần tự đều là node trong graph.
- OTel tích hợp sẵn: mọi model call và tool execution sinh trace có cấu trúc.
- **Đem vào open-bot**: T1 memory v-next — session bền kiểu ADK: state machine tường minh
  cho agent run dài ngày (schema bước + event gate chờ phê duyệt/webhook, SQLite local,
  resume sau restart), phân tách Session/State/Memory/Artifact đúng lifetime; T6
  platform/fleet v-next — cây multi-agent phân cấp: parent delegate + parallel fan-out/gather
  với state bền từng child.

## 2. Vercel AI SDK 6/7 — agent là unit tái dùng, approval là first-class (vercel/ai, Apache 2.0)

- AI SDK 6 (22/12/2025) đưa ra **Agent abstraction**: `ToolLoopAgent` gói model + tool +
  `stopWhen` thành một unit tái dùng được ở chat UI, background job, API endpoint; mặc định
  `stepCountIs(20)` — loop có giới hạn, không phải ma thuật. AI SDK 7 (25/06/2026) thêm
  `WorkflowAgent` bền (mỗi tool call là một durable step có retry), timeout/sandbox support,
  telemetry, lifecycle callback, Node.js tracing channel.
- **Tool approval là first-class, không phải code tay**: tool đánh dấu `needsApproval` thì
  SDK tự pause execution, trình action đề xuất cho user duyệt, resume chỉ sau khi approve;
  SDK 7 ký HMAC cho approval. Bài học: approval phải là primitive của runtime, không phải
  if lẻ trong từng tool.
- Provider-agnostic thật: cùng một agent code chạy OpenAI, Anthropic, Google (Gemini), xAI
  Grok, Mistral… qua interface thống nhất; tool định nghĩa bằng schema (Zod/JSON Schema),
  có per-tool `strict`, structured output qua `Output.object({ schema })`.
- **MCP Apps** (SDK 7): MCP server không chỉ trả tool/text mà trả cả UI tương tác render
  trong chat; DevTools + terminal UI để inspect step agent đã đi.
- **Đem vào open-bot**: T2 protocols v-next — agent runtime kiểu AI SDK: `ToolLoopAgent`
  tái dùng + `WorkflowAgent` durable step, approval primitive (`needsApproval`, pause/resume,
  audit log, ký xác nhận), provider-agnostic agent interface; T4 Composio/MCP v-next —
  MCP Apps: server trả UI component render trong chat + DevTools inspect trajectory.

## 3. LiveKit Agents vs Pipecat — voice pipeline là bài toán latency + turn-taking (2026)

- Ba kiến trúc voice: **cascaded** (STT → LLM → TTS, stream chồng nhau), **turn-based
  realtime** (một model speech-to-speech, chờ hết lượt: OpenAI Realtime API, Gemini Live),
  **full-duplex** (một model vừa nghe vừa nói, tự quyết lấy/nhả lượt: GPT-Live, GA API
  10/09/2026, $0.05/phút). Realtime API GA 28/08/2025; gpt-realtime-2.1 (06/07/2026,
  128k context); Gemini 3.8 Live GA 15/09/2026 (async function calling mặc định).
- **Latency là bài toán chính, không phải model**: bảng latency 16 stage tổng 1.293 ms,
  mục tiêu voice-to-voice 1.500 ms; speech-to-speech ~300 ms, cascade thêm 300–800 ms.
  Framework gần như không quyết định latency — model quyết định; framework quyết định
  turn-taking và độ tin cậy.
- **Pipecat** (BSD-2, ~16k stars, v1.15.0 29/10/2026): pipeline tường minh các processor
  (transport in → STT → context → LLM → TTS → transport out), transport-agnostic (Daily,
  LiveKit, Twilio, WebSocket), backpressure (TTS chậm thì upstream pause), interruption
  cấu hình được, Smart Turn v3 (open, chạy local CPU) quyết định hết lượt từ audio.
- **LiveKit Agents** (Apache 2.0, ~14.7k stars, Python 1.8.10 / Node 1.9.5 29/10/2026):
  agent là participant trong LiveKit room, media server WebRTC lo transport + dispatch +
  load balancing + SIP telephony; TurnDetector chạy trên audio (ngữ điệu + nội dung),
  PII redaction từ 1.7.0. Chọn LiveKit khi ở trong phòng WebRTC nhiều người/video; chọn
  Pipecat khi cần kiểm soát từng bước pipeline và transport riêng.
- Cả ba framework (kể cả OpenAI Agents SDK) đến 10/2026 đều có cách test agent trong CI.
- **Đem vào open-bot**: T5 voice v-next — pipeline voice kiểu Pipecat: processor chain
  tường minh (VAD → turn detector → STT → LLM+tools → TTS), backpressure + interruption,
  turn detection từ audio (local, CPU), latency budget instrumentation từng stage với mục
  tiêu 1.500 ms end-to-end, transport abstraction (WebRTC/WebSocket/telephony mock), eval
  voice trong CI.

## 4. Agent execution sandbox — code agent viết ra là input không tin cậy (2026)

- Threat model chuẩn (SWE-bench, OpenDevin, Claude computer use): output của model là
  input không tin cậy — chạy bằng exec/subprocess trong process chứa DB URL + API key thì
  một trang web/README độc hại đủ biến thành code execution trên server. Sửa bằng stack
  ngắn: chạy code ở nơi disposable, timeout + resource budget cứng, egress quyết định trước,
  credential không vào box.
- **Bốn provider, bốn isolation**: E2B — Firecracker microVM, cold start snapshot 5–30 ms,
  ~$0.000014/sandbox-giây, pause/resume bền, managed không có GPU; Daytona — Docker +
  gVisor, 200–500 ms, workspace giữ file state xuyên invocation, MCP gateway trưởng thành
  nhất (agent nối MCP client là chạy trong sandbox, không cần integration riêng);
  Vercel Sandbox — Firecracker, mặc định 5 phút, tối đa 5h (enterprise); Modal — gVisor
  hoặc VM, GPU sandbox được nhưng có thể bị preempt.
- **Hierarchical sandbox**: microVM ngoài chứa container trong — vừa có kernel riêng vừa
  có Docker API. Self-host E2B OSS trên bare metal là đường duy nhất có GPU passthrough
  (gVisor chặn PCIe passthrough); break-even self-host vs managed ~11.000 sandbox-giờ/tháng.
- **Eval harness chạy trong sandbox song song**: mỗi task SWE-bench một sandbox riêng,
  32 runtime song song rút full run từ nhiều ngày xuống vài giờ; SWE-bench Lite 300 task
  ~50 GPU-giờ, ~$160–265 trên H100; SWE-ReX chạy session agent xuyên backend sandbox từ xa.
  Tính tái lập là yêu cầu: cùng trajectory phải cho cùng outcome quan sát được.
- **Đem vào open-bot**: T3 coding agent v-next — sandboxed code execution local-first:
  BotBox (bwrap) nâng cấp thành sandbox pool có lifecycle (spawn/pause/resume/snapshot),
  egress allowlist/denylist, resource budget, audit log từng filesystem write + network
  request ở mức tool-call, MCP gateway cho sandbox; T3 kèm eval harness SWE-bench-style
  local: task chạy trong sandbox riêng, chạy song song có giới hạn, pass/fail + trajectory
  lưu lại làm dataset.

## 5. Ghi chú sóng v1.31

- v1.30 đang chạy (coordinator cử 15:01, 6 đội v130-t1..t6 đều đã có commit; merge/v130
  mới chỉ gộp xong v129 + survey v130, chưa gộp đội v130 nào). Sóng v1.31 chạy SONG SONG
  trên nhánh merge/v131 riêng — base lúc cử là merge/v130 @ 726f7368.
- Coordinator v1.31 PHẢI đọc merge/v130 HEAD bằng grep để lấy đúng số version hiện tại của
  từng subsystem rồi mới đặt số mới (tránh va chạm kiểu v1.27/v1.28: cùng protocolsV5, cùng
  voiceV19). Số version trong survey này chỉ là gợi ý hướng, không phải số cuối.
- Trước khi cử đội: kiểm tra merge/v130 có tiến thêm không (coordinator v1.30 đang gộp đội);
  nếu có, merge (KHÔNG rebase — tránh viết lại base của các đội v130/v131) merge/v130 mới
  vào merge/v131 rồi mới cử đội. Trước khi gộp cuối: merge merge/v130 mới nhất một lần nữa.
- Main vẫn ở v1.20 (ec4bf689, suite ĐỎ lúc land) — các sóng v1.21–v1.30 đang xếp chồng trên
  nhánh merge/v12X/v130, chưa land main, remote GitHub vẫn v1.17 (2/11). Sóng v1.31 KHÔNG
  tự fast-forward main, KHÔNG đẩy GitHub — chỉ gộp + kiểm chứng xanh trên merge/v131 rồi
  báo cáo. Việc land main + đẩy GitHub là bước riêng sau, do cycle worker quyết định.
- Daemon restart đã giết nhiều coordinator/đội các sóng trước: commit sớm + thường xuyên;
  đội nào chết thì cử đội thay thế tiếp tục từ HEAD nhánh đội đó, không làm lại từ đầu.
