# Repo survey v1.37 — 2026-11-18

Nghiên cứu phục vụ sóng v1.37. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Memory "dreaming" — consolidation chạy nền (Anthropic, Mem0, Letta, 11/2026)

- Anthropic công bố nghiên cứu "The components of agent memory" ngày 06/11/2026: **Dreams for
  Claude Managed Agents** (research preview) — một lượt chạy offline giữa các phiên: Claude
  đọc lại transcript, sửa ghi chú sai, xây representation dạng wiki, và giữ lớp "luôn nạp"
  (always-loaded) nhỏ. Ví dụ minh chứng: một ghi chú sai trong run Pokémon Red được lượt
  offline sửa lại. Chưa có trên app Claude tiêu dùng, chỉ một số model, phải đăng ký chờ.
- Mem0 **Dream** (04/08/2026): job nền gộp (merge) các memory trùng, đánh dấu fact mới thay thế
  fact cũ (supersede), tổng hợp pattern lặp lại thành fact bền.
- Letta **dreaming**: subagent nền cập nhật memory; kích hoạt sau N bước agent hoặc khi
  compaction. Letta còn có sleep-time agent viết `learned_context` vào block chung.
- Gốc nghiên cứu: **sleep-time compute** (Lin et al., arXiv 2504.13171, 04/2025) — dùng thời
  gian rảnh giữa các lượt tương tác để tổ chức lại context; **Auto-Dreamer** (arXiv 2605.20616,
  05/2026) viện dẫn complementary learning systems. Harrison Chase liệt kê dreaming như một
  hướng ngày 28/10/2026. Bài "Agent Memory Consolidation" (maximem.ai, cập nhật 13/11/2026)
  định nghĩa job nightly phải làm: gộp trùng, supersede, hết hạn fact có thời hạn, pattern lặp
  → một fact bền — và phải kiểm chứng được job đã làm gì (báo cáo có bằng chứng).
- Ba tên gọi (sleep-time compute / dreaming / consolidation) chỉ một ý tưởng chồng lấp: lượt
  nền đọc thứ agent đã lưu (+ transcript gần đây) và viết lại bản sạch hơn, ngoài critical path.
- **Đem vào open-bot**: T1 memory v18 — dreaming job local-first: chạy theo lịch / sau N bước /
  khi compaction; gộp trùng, supersede fact bị mâu thuẫn, hết hạn fact có hạn, tổng hợp
  pattern → fact bền, xây wiki representation; báo cáo consolidation có bằng chứng từng thay
  đổi (fact nào gộp/supersede/hết hạn, vì sao); giữ lớp always-loaded dưới ngân sách ký tự;
  mọi thay đổi đều có thể revert (audit log + snapshot trước khi dream).

## 2. OpenHands 1.39–1.41 + Software Agent SDK 1.60.1 (11/2026)

- OpenHands cloud: **v1.39.0** (11/11) — lọc automation dashboard theo owner (Service accounts),
  Stop hook giữ feedback ngoài chat, Paper theme; **v1.40.0** (12/11) — hướng dẫn xác thực
  Codex subscription tốt hơn, sửa chat draft/history; **v1.41.0** (16/11) — verify-openhands
  scenarios vượt happy path, ACP reasoning effort, hooks dialog, dashboard automation gom theo
  tag.
- Agent Canvas **1.38.0** (10/11): **conversation budget meter** — so spending của một
  conversation với budget cap, chỉ báo cáo, KHÔNG enforce (spending và % hiển thị đều có thể
  vượt cap); **Agent Profiles** cho prompt/plugin preset — chọn profile thay vì model riêng,
  profile ACP hiển thị `ACP` thay cho tên model; chọn ACP agent lúc onboarding lưu thành
  profile riêng, không ghi đè `default`.
- Software Agent SDK **v1.60.1** (05/11): vá CVE-2026-109518, apt qua HTTPS với base pin,
  dừng container khi Docker/Apptainer khởi động lỗi. Các tính năng runtime gần đây vẫn giữ
  nguyên giá trị: **per-conversation Docker runtime** (v1.49.0) — mỗi conversation một runtime
  riêng mà không đổi API conversation; **profile-scoped secrets** (v1.48.0) — credential thu
  hẹp theo conversation thay vì server-global; **archive runtimes** của conversation Docker
  lâu không hoạt động; **reclaim cache** và **shed gitignored dirs** của runtime đã dừng khi
  vượt disk budget; agent profiles thay thế persona; per-conversation runtime choice.
- **Đem vào open-bot**: T4 coding agent v-next — agent profiles (persona + tool set + model
  theo profile, profile ACP hiển thị `ACP`); budget meter chỉ-báo-cáo cho từng run/bot (token +
  chi phí ước tính vs cap, vượt cap vẫn chạy nhưng cảnh báo rõ); hooks dialog (stop hook giữ
  feedback ngoài chat); T3 sandbox v5 — per-bot runtime choice, archive runtime lâu không dùng,
  reclaim cache + shed thư mục gitignored khi vượt disk budget, secret thu hẹp theo bot/run.

## 3. ACP v2 draft + Elicitation ổn định; A2A v1.1 RC; Poppy mới ra (11/2026)

- **Agent Client Protocol** (agentclientprotocol.com, cập nhật 06/11/2026): RFD **Elicitation
  đã Completed** — form có cấu trúc + URL-mode ổn định: agent xin input có cấu trúc
  (không nhạy cảm) hoặc đẩy user sang flow ngoài băng tần an toàn; client quảng bá rõ mode
  mình hỗ trợ. **ACP v2 đã có bản Draft**: thay diff oldText/newText bằng structured file
  changes, `session/update` đến được ngoài prompt turn, `session/prompt` trả về id của user
  message thay vì đánh dấu hết turn. ACP v1 vẫn là stable (Schema v1.29.1, 02/11/2026);
  team ACP yêu cầu implementer tiếp tục hỗ trợ v1 song song v2.
- **A2A**: v1.0 ra 12/03/2026 (JSON-RPC, gRPC, HTTP+JSON), patch v1.0.1 tháng 5; **v1.1 RC
  gắn tag cuối tháng 10** thêm two-way streaming trong lúc task chạy. Tháng 8/2026 A2A về
  chung nhà với MCP trong Agentic AI Foundation (Linux Foundation).
- Bản đồ giao thức tháng 11/2026: MCP = tay của agent (spec hiện tại 2026-07-28, stateless);
  A2A = agent nói với agent (Agent Card tại `/.well-known/agent.json`, discovery, delegate);
  AG-UI/A2UI = mặt của agent (agent mô tả UI khai báo, app tự render, không chạy code lạ);
  AP2 v0.2 (mandate ký số cho thanh toán) đã tặng cho FIDO Alliance; ACP (Agentic Commerce
  Protocol, OpenAI + Stripe) là chuẩn thương mại — KHÁC với Agent Client Protocol, đừng
  nhầm acronym. IETF lập working group **Agent Communication Protocols** tháng 10/2026,
  mục tiêu một base protocol chung mà MCP và A2A đều mang được.
- Mới tinh: **Poppy — Personal Agent Protocol 1.0** (Sierra, 13/11/2026, phát triển cùng Meta):
  cách agent cá nhân của user kết nối tới một business (qua website, API hoặc agent của
  business). Mới 5 ngày tuổi — chỉ theo dõi, CHƯA xây lên trên.
- **Đem vào open-bot**: T2 protocols v-next — ACP v2 draft (structured file changes, update
  ngoài turn, prompt trả message id) chạy song song v1; elicitation ổn định (form + URL-mode,
  client advertise mode); A2A v1.1 two-way streaming cho task đang chạy; registry ghi rõ
  "Poppy: theo dõi, chưa implement"; IETF ACP-WG theo dõi qua bảng "tested with" có ngày.

## 4. Các CLI agent train tháng 11/2026 — mẫu để học (không copy)

- **claude-code v2.1.322** (10/11): Vertex fast mode với fallback standard-speed, Fable 5.2
  mặc định ở context 1M.
- **codex rust-v0.168.0** (13/11): Sessions model-provider browser, TUI workspace side
  conversation, audio-recording attachments, tạo GIF động opt-in, tmux passthrough image
  preview (Ghostty/Kitty), OSC 777 notifications.
- **copilot-cli 1.0.109** (10/11): CIDR sandbox rules, Fable 5.2 trong picker.
- **gemini-cli v0.68.0**, **opencode v2.2.7** (Copilot Auto trong model picker),
  **crush v0.101.0** (command-palette skill toggles + skill hỏng được đánh dấu và giải thích,
  live per-tool-call timers, request compression sang Hyper), **goose v1.59.0**.
- Mẫu chung đáng học: model picker hiển thị provider/model động (Copilot Auto, Fable 5.2);
  sandbox rules theo CIDR; per-tool-call timers + skill toggle có giải thích khi hỏng;
  side conversation trong workspace (không phá conversation chính).
- **Đem vào open-bot**: T6 fleet v24 — automation dashboard gom theo tag + lọc theo owner,
  Stop hook feedback; T5 voice v24 — tiếp tục tuyến voice; model picker hiển thị provider
  động + sandbox CIDR rules trong router local; per-tool-call timers ở UI chạy bot.
