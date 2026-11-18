# Khảo sát repo hệ thống lớn — sóng v133 (17/11/2026)

Nghiên cứu phục vụ sóng v1.33 của open-bot. CHỈ HỌC Ý TƯỞNG — không copy
code/text/tài sản của bất kỳ repo nào, của xAI/Cursor/Anthropic.

Các sóng trước đã khảo sát: v130 (Temporal durable execution, OTel GenAI
observability, local inference broker), v131 (Google ADK 2.0, Vercel AI SDK
6/7, LiveKit/Pipecat voice, agent sandboxes), v132 (Agent Skills SKILL.md,
sandbox snapshot/fork, multi-agent orchestration, Ralph loop, eval harness).

## 1. Claude Code — plugin marketplace, hooks, subagent, LSP

Nguồn: thepromptshelf.dev (plugin marketplace 2026), tw93.fun (kiến trúc
6 lớp), mcp.directory (skills vs subagents vs plugins vs hooks),
sidharthsatapathy.com (phân tích 512.000 dòng Claude Code 2.1.88),
finwiki.zksc.io (extension component architecture).

Ý tưởng học được:

- **Plugin = gói phân phối, không phải runtime primitive.** Một plugin là
  một thư mục chứa: skills (`skills/<name>/SKILL.md`), subagent
  (`agents/`), hooks (`hooks/hooks.json`), MCP server (`.mcp.json`), LSP
  server (`.lsp.json`), slash command. Marketplace là file `marketplace.json`
  liệt kê plugin + vị trí. Cài một lần bằng `/plugin install`, cả team dùng
  chung. Marketplace chính thức của Anthropic có LSP cho 11 ngôn ngữ,
  tích hợp GitHub/Figma/Slack/Sentry, security review.
- **Bốn primitive trực giao, không thay thế nhau:** Skill trả lời "model
  biết làm gì" (quy trình Markdown + frontmatter, auto-load khi khớp mô
  tả); Subagent trả lời "ai đang làm" (context riêng, tool allowlist
  riêng, model riêng tùy chọn); Plugin trả lời "phân phối thế nào";
  Hook trả lời "điều gì phải xảy ra một cách tất định quanh vòng lặp"
  (model không được từ chối kích hoạt). Quy tắc: tool/MCP cho hành động
  mới, skill cho phương pháp tái dùng, subagent để cô lập, hook để ép
  chính sách và thu tín hiệu audit.
- **Hook lifecycle:** PreToolUse, PostToolUse, UserPromptSubmit,
  SessionStart, SubagentStop, PreCompact và ~20 sự kiện khác. Hook nhận
  context qua stdin (JSON) + biến môi trường, giao thức exit-code nghiêm
  ngặt — hook quét secret rò rỉ ở PreToolUse, chạy ESLint sau edit,
  chặn `rm -rf`, log mọi lần ghi file. Hook là lớp an toàn cốt lõi,
  không phải tính năng phụ.
- **Subagent có sẵn:** Explore (chỉ đọc, chạy model rẻ để tiết kiệm),
  Plan (nghiên cứu lập kế hoạch), General-purpose, Verify, Guide.
  `forkSubagent` với context bộ nhớ cô lập là first-class; song song
  hóa là thiết kế, không phải tình cờ.
- **KAIROS + DreamTask:** chế độ tự trị sâu (234 tham chiếu KAIROS trong
  source); DreamTask là subagent củng cố bộ nhớ chạy lúc idle với 4 pha:
  orient → gather → consolidate → prune. CLAUDE.md có ngân sách 12.000
  ký tự tổng, 4.000 ký tự/file.
- **LSP trong plugin:** jump-to-definition, find-references, diagnostic
  lỗi type sau mỗi lần sửa — code intelligence realtime cho agent, không
  chỉ grep/repo-map tĩnh.

Áp dụng cho open-bot (sóng v133, đội T1/T3/T6):

- Plugin marketplace nội bộ: manifest `plugin.json` + marketplace catalog,
  cài plugin = skills + subagent + hooks + MCP + LSP một lần; registry
  plugin có chữ ký/hash (bài học ClawHavoc ở v132).
- Hook engine v2: PreToolUse/PostToolUse/SessionStart/SubagentStop/
  PreCompact, chạy script local, exit-code chặn/bỏ qua, audit log mọi
  lần hook chặn tool call; hook quét secret trước tool call.
- Subagent chuyên biệt: Explore (model rẻ, chỉ đọc), Plan, Verify
  (chạy test + đối chiếu diff), DreamTask củng cố memory lúc idle
  (orient/gather/consolidate/prune) nối vào memory v21+.
- LSP client cho coding agent: diagnostics realtime sau mỗi edit thay vì
  đợi build cuối; hỗ trợ TS/Python/Go/Rust/Java trước.

## 2. SWE-bench / SWE-agent — eval harness chấm bằng thực thi

Nguồn: callsphere.ai (SWE-bench 2026), bestaiweb.ai (định nghĩa + cách
chạy harness), spheron.network (benchmark trên GPU cloud).

Ý tưởng học được:

- **Chấm bằng thực thi, không chấm bằng ý kiến.** Mỗi instance là issue
  GitHub thật + snapshot repo trước fix + test ẩn. Agent phải ra patch
  (unified diff); harness apply patch vào Docker container, chạy test
  của repo: chỉ tính resolved khi mọi test FAIL_TO_PASS đều pass và mọi
  test PASS_TO_PASS vẫn pass. Không partial credit, không LLM-as-judge.
- **Các split không thay thế nhau:** Full 2.294 instance (8–12% mơ hồ/
  không giải được — đừng quote số full năm 2026); Verified 500 instance
  (OpenAI + tác giả gốc, 3 chuyên gia review từng cái, dùng để so sánh
  model); Lite 300 (chỉ fix 1 file — vòng lặp nội bộ, không so sánh
  liên-lab vì thiên vị single-file); Multimodal (JS + screenshot);
  Multilingual (9 ngôn ngữ, 42 repo); Pro ~731 (Scale AI, kháng
  contamination, top score chỉ ~50–60% giữa 2026). Verified là trần,
  không phải ground truth — OpenAI đã bỏ vì test lỗi + contamination;
  cross-check bằng Pro.
- **Harness = 4 phần độc lập, phần nào cũng có thể hỏng riêng:** dataset
  split, predictions file (JSONL: instance_id, model, model_patch — thứ
  duy nhất harness đọc từ phía agent), harness (`swebench` 4.1.0, Python
  3.10+, Docker x86_64), kết quả (% resolved). Mỗi worker: pull task →
  spin Docker sandbox → gọi agent → ghi patch thô ra shared volume;
  worker stateless nên spot instance bị preempt chỉ làm task rơi lại
  queue. Chạy Verified 500 task bằng API model mạnh tốn ~$60–80; bằng
  model 70B tự host tốn ~500 H200 GPU-giờ.
- **Benchmark nội bộ mới là thứ lab dùng để iterate thật:** lấy issue
  thật từ chính repo của mình, rẻ, đại diện cho production code hơn số
  public. Một run SWE-bench-Lite cho agent tùy chỉnh xong trong một buổi
  chiều + vài trăm đô compute — rào cản thấp, rào cản làm *có trách
  nhiệm* (cost ceiling, diễn giải đúng) mới cao.

Áp dụng cho open-bot (đội T3 coding agent + T5 eval):

- Eval harness v2 cho coding agent: fixture repo local (lấy issue + fix
  thật từ chính open-bot), chạy trong sandbox/bwrap, chấm FAIL_TO_PASS /
  PASS_TO_PASS, báo % resolved + cost/task + thời gian/task; tách split
  nội bộ (Lite 1-file) và split khó (cross-file, Pro-style).
- Predictions file chuẩn JSONL (instance_id, model, patch) để harness
  nào cũng đọc được; worker stateless, queue + retry khi sandbox chết.
- Quy tắc báo cáo: mọi số eval phải kèm spec (split, harness version,
  host arch, ngày chạy) — số không kèm spec là tin đồn.

## 3. Browser-use / Stagehand / Playwright MCP / Skyvern — computer-use

Nguồn: techiehub.blog (so sánh 2026), changegamer.ai (computer-use 2
lớp), menuagentic.com, dreaming.press (browser-use vs Stagehand vs
Playwright MCP).

Ý tưởng học được:

- **Hai lớp tách biệt:** (1) API vision/GUI-grounding (Anthropic
  computer-use, OpenAI CUA, Google Gemini) — screenshot vào, action có
  cấu trúc ra; (2) harness thực thi (Playwright MCP, browser-use,
  Stagehand, Skyvern) — chạy action, trả state mới về. Computer-use của
  Anthropic đã GA (`computer_toolset_20260801`, Opus/Sonnet 5.5); OpenAI
  Operator nghỉ 31/08/2025, ChatGPT Agent bị gỡ đầu 08/2026, thay bằng
  Dots (29/09/2026, always-on agent).
- **Phổ perception quyết định mọi thứ:** đầu có cấu trúc (accessibility
  tree) ↔ đầu thị giác (screenshot). Playwright MCP (Microsoft, Apache
  2.0, 34k+ star) cho snapshot a11y tree — không cần vision model, nhanh,
  tất định, là cách chuẩn để đưa browser cho mọi MCP client; opt-in
  vision bằng `--caps vision`. browser-use (Python, MIT, 100k+ star,
  ~89% WebVoyager 586 task) parse DOM thành danh sách element đánh số +
  vision tùy chọn, model-agnostic. Stagehand v4 (Browserbase, MIT, TS)
  giữ tay lái trong code (`act`/`extract`/`observe`/`agent`), chỉ gọi
  model chỗ selector gãy; v4 thêm SDK Python/Go + Model Gateway chọn
  model rẻ nhất đủ làm từng action. Skyvern (YC, vision-first, 23k+
  star, 10M+ workflow) chuyên điền form bằng thị giác.
- **Quy tắc chọn:** muốn agent tự plan + tự click, viết Python →
  browser-use; muốn code tất định + AI chỉ chỗ selector gãy, viết TS →
  Stagehand; đã có MCP client chỉ cần chạm tới web → Playwright MCP.
  Chiến thắng production là hybrid: a11y-tree trước, fallback tọa độ/
  vision khi không có role ARIA.
- **Chi phí thật:** mỗi vòng lặp tốn ≥1 model call + 1 screenshot;
  latency + vision-token cộng dồn theo số bước. Re-send toàn bộ page
  state mỗi bước nên context/step — không phải browser — mới là nút
  thắt. A11y-tree rename role ARIA thì gãy — cần fallback.

Áp dụng cho open-bot (đội T3/T4):

- Browser driver v2: snapshot a11y-tree làm perception chính (rẻ, tất
  định), fallback screenshot + tọa độ khi element không có trong tree;
  cache snapshot theo step, chỉ gửi diff về model để giảm token/step.
- Playwright MCP server mode: expose browser control thành MCP tool cho
  mọi MCP client, tương thích chuẩn Microsoft.
- WebVoyager-style self-eval: bộ task web thật, đo % success + cost/task,
  chạy trong sandbox với egress allowlist (chống page hijack agent —
  trang độc có thể lái agent, phải có security gate ở mỗi step).

## 4. Local inference — llama.cpp / Ollama / vLLM / SGLang

Nguồn: techloghub.com (llama.cpp), essamamdani.com (tooling 10/2026),
cognativ.com (local agent guide), sysart.consulting, blog.nemesisnet.co.za
(so sánh 4 engine).

Ý tưởng học được:

- **Bốn engine, bốn việc:** Ollama = "Docker cho LLM" (1 lệnh cài,
  1 lệnh chạy, ~41 TPS, outgrow ở ~5 user đồng thời); llama.cpp =
  engine tham chiếu (C/C++, GGUF, mmap, chạy từ Raspberry Pi tới H100,
  kiểm soát quantization Q4_K_M/Q5_K_M/Q6_K/Q8_0 từng layer); vLLM =
  serving production (PagedAttention, continuous batching, chunked
  prefill, prefix caching, speculative decoding, ~793 TPS peak, 10+
  user); SGLang = cho agent pipeline (RadixAttention, disaggregated
  prefill/decode, structured output first-class).
- **Tool calling đã là chuẩn ở cả 4:** Ollama nhận `tools` ở `/api/chat`
  (+ endpoint OpenAI-compatible, nhưng không hỗ trợ `tool_choice`);
  llama.cpp server bật function calling bằng `--jinja`, có handler native
  cho Llama 3.x/Qwen 2.5/Hermes/Mistral Nemo/gpt-oss, parallel call tắt
  mặc định, KV cache quantization mạnh làm hỏng tool calling;
  vLLM cần `--enable-auto-tool-choice` + `--tool-call-parser`
  (hermes/llama3_json/openai), doc thừa nhận: forced call chỉ đảm bảo
  parse được, không đảm bảo đúng — auto mode vẫn có thể gãy schema nếu
  không bật strict mode. Bài học chung: **validate mọi tool call trước
  khi thực thi.**
- **Structured output là grammar, không phải hy vọng:** schema-constrained
  JSON / GBNF grammar ép output khớp schema; Ollama siết grammar ngay
  trong runner để agent loop nhận payload đã validate, khỏi retry hậu
  xử lý. Xu hướng: MCP native trong runtime (Ollama tự declare tool),
  telemetry OTel ngay trong engine (vLLM/llama.cpp xuất trace span ở
  tầng C++).
- **Ngưỡng thực tế:** Ollama khuyến nghị context ≥64.000 token cho agent/
  coding/search; llama.cpp v0.8.0 (28/10/2026) có router mode, parallel
  decoding, speculative decoding với draft model; Ollama server nghe
  127.0.0.1:11434, không auth — phải bật `OLLAMA_NO_CLOUD=1` trên máy
  quản lý để giữ local-only; gpt-oss-20b chạy trong 16GB RAM, Apache 2.0,
  function calling + structured output native.

Áp dụng cho open-bot (đội T2/T3 — inference broker v2):

- Capability matrix theo engine: tool calling (parser nào, parallel?,
  strict?), structured output (grammar/schema?), context tối đa khuyến
  nghị, batching; router chọn engine + model theo task (coding → model
  có tool calling native + context ≥64k; extract → grammar-constrained).
- Validate tool call trước khi thực thi ở mọi engine (schema check +
  allowlist tool), không tin parser của engine.
- Probe engine lúc khởi động (đo tool-call parser thật bằng 1 call mẫu),
  ghi capability vào registry; fallback Ollama → llama.cpp server khi
  Ollama thiếu `tool_choice`/strict mode.
- SGLang-style prefix-cache reuse cho multi-turn agent loop (RadixAttention
  ý tưởng: cache prompt prefix chung giữa các turn) — giảm latency/turn
  khi chạy local.

## Ưu tiên sóng v133 (đề xuất cho coordinator)

1. T1 memory v22: DreamTask củng cố memory lúc idle (orient/gather/
   consolidate/prune) + hook SessionStart nạp memory đã củng cố.
2. T2 protocols v8: plugin marketplace nội bộ (manifest + catalog +
   hash/chữ ký) + hook engine v2 (Pre/PostToolUse, SessionStart,
   SubagentStop, PreCompact; chặn + audit).
3. T3 coding agent v17: eval harness SWE-bench-style (fixture local,
   FAIL_TO_PASS/PASS_TO_PASS, JSONL predictions) + LSP diagnostics
   realtime sau edit.
4. T4 Composio/apps v7: browser driver v2 (a11y-tree chính + vision
   fallback, diff snapshot, Playwright MCP server mode, egress gate).
5. T5 voice v22: inference broker v2 (capability matrix 4 engine, probe
   tool-call parser, validate trước thực thi, prefix-cache cho loop).
6. T6 platform/fleet v20: subagent chuyên biệt (Explore/Plan/Verify) +
   UI panel quản lý plugin/hook/eval (progressive disclosure).

## Ghi chú

- Không copy code/text/tài sản của repo nào. Mọi con số (star, benchmark,
  giá) lấy từ nguồn trên, ngày 17/11/2026; kiểm chứng lại trước khi đưa
  vào doc sản phẩm.
- Live ảnh Gemini KHÔNG thử lại (key miễn phí quota ảnh = 0).
