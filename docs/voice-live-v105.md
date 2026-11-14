# Voice realtime v4 — v1.05 (Đội T5)

Nâng cấp voice realtime trên nền v3 (long session bền +
media conversation + barge-in v3): đo độ trễ từng chặng,
ngắt lời tin cậy hơn, panel v4, quản lý nhiều phiên, eval
nội bộ. Test: `tests/voice-v105.test.mjs` — **21/21 pass**.

## 1. Latency pipeline (`latencyPipeline.ts`)

- `LatencyHistogram`: mẫu latency một chặng, histogram theo
  bucket + p50 / p95 / p99. p99 có ý nghĩa với voice: p95
  300 ms vẫn có thể giấu một lần kẹt 2 s làm chết lượt nói.
  Mẫu âm / NaN bị bỏ, không làm bẩn báo cáo.
- `VoiceLatencyPipeline`: 6 chặng một lượt nói (capture →
  VAD → STT → LLM → TTS → playback), ghi theo thứ tự bằng
  clock inject được; chặng tới sai thứ tự bị bỏ, không đoán.
  `endTurn()` ghi độ trễ end-to-end (lượt nói bắt đầu ở
  request → chunk audio đầu tiên). Báo cáo theo phiên:
  từng chặng + end-to-end + chặng chậm nhất theo p95 +
  độ sâu jitter buffer. Chặng không ai đo thì báo `null`
  ("not measured"), không bịa số.
- `AdaptiveJitterBuffer`: độ sâu playout theo jitter — EWMA
  độ lệch khoảng tới gói tin; jitter cao tăng một bước,
  đường truyền êm giảm một bước; kẹp trong [min, max].
- Chế độ latency (`balanced` / `low-latency`): một chỗ nói
  rõ "low latency" đổi gì — chunk 20 → 10 ms, VAD hangover
  300 → 100 ms, jitter buffer 120/400 → 60/160 ms, bỏ VAD
  local, prefetch TTS. Nút chuyển mode trên panel là đổi
  config thật, không phải nhãn.

## 2. Barge-in v4 (`bargeInV4.ts`)

- Energy gate: frame chỉ tính khi RMS ≥ ngưỡng (mặc định
  0.02) — tiếng ồn phòng / vọng không khởi động ngắt lời.
- VAD + debounce: VAD phải nói "speech" VÀ đủ N frame lớn
  liên tiếp (mặc định 3) trong cửa sổ 500 ms — một tiếng ho
  hay sập cửa không giết câu trả lời.
- State machine `idle` → `listening` → `interrupted` —
  panel hiện trạng thái, không đoán.
- Huỷ TTS < 50 ms: `interrupt()` đo thời gian dừng thật
  (caller truyền hàm stop; mock đo được, test đo 12 ms).
  Mỗi lần dừng quá ngưỡng là một breach, đếm + báo.
- Resume partial utterance: câu model đang nói dở được giữ
  lại, `buildResumeUtterance()` tạo prompt "tiếp tục đúng
  chỗ đã dừng" thay vì trả lời lại từ đầu.

## 3. Voice session v4 (`voiceSessionV4.ts`)

- Bọc `VoiceSessionV3`: pipeline + barge-in v4 + lịch sử
  lượt nói (user/model, thời gian, có bị ngắt không).
- Chỉ nối những gì session quan sát được một cách trung
  thực: độ trễ lượt nói = request → chunk audio đầu tiên;
  các mark chặng (capture/VAD/STT/LLM/TTS) do caller đã đo
  đưa vào qua `markStage()` / `recordStage()` (local stack,
  test). Không tách một khoảng thời gian quan sát được
  thành các chặng không nhìn thấy.
- `noteAudioFrameV4()` — đường local: frame qua energy
  gate + VAD + debounce → xác nhận ngắt thì huỷ reply qua
  v3 và đo thời gian dừng TTS theo ngân sách 50 ms.
- `noteModelSpeechStarted()` — đường TTS local báo model
  đang nói (đường provider làm việc này từ event `audio`).
- `createMockVoiceSessionV4()` — session mock cho manager
  và tools (MockRealtimeTransport, không key, không mạng).
- Event mới: `latency-report`, `barge-in-v4`,
  `latency-mode` (cộng toàn bộ event v3).

## 4. Session manager v2 (`voiceSessionManagerV2.ts`)

- Nhiều phiên: start / pause / resume / stop. Pause ngắt
  transport nhưng giữ wrapper (checkpoint của v3 sống qua
  disconnect); resume nối lại cùng config. Stop gỡ khỏi tập.
- Giới hạn đồng thời (mặc định 3): start vượt cap bị từ
  chối và nêu tên các phiên đang chạy — manager không bao
  giờ giết cuộc gọi lặng lẽ. Phiên pause không chiếm slot.
- Session log: mọi vòng đời + lần reconnect được append
  vào store (memory trong test, JSON-lines file trong app:
  `FileVoiceSessionLogStore`, dòng hỏng được bỏ qua, prune
  theo max entries). Log hỏng không bao giờ làm chết cuộc
  gọi.
- Reconnect sau mất kết nối: redial với backoff nhân đôi +
  jitter 0.2 (dùng chung `Backoff`), tối đa 3 lần/drop;
  pause/stop có kế hoạch không bao giờ trigger reconnect.
- Lỗi thật bắt được: `startSession` ban đầu bỏ qua
  `latencyMode` (factory không nhận config) — sửa bằng
  cách truyền config vào factory; `VoiceLatencyPipeline`
  không validate mode — sửa: mode lạ về `balanced`.

## 5. Voice eval nội bộ (`voiceEval.ts`)

- WER mock: từng case gồm ground truth fixture + transcript
  STT (mock) đưa ra, chấm bằng `wordErrorRate` của STT
  pipeline v0.96 — cùng một định nghĩa WER. Hypothesis rỗng
  chấm WER 1 (thất bại), không skip. Fixture 4 case (en+vi):
  3 pass ở ngưỡng 0.2, mean WER 0.113.
- Barge-in latency: mẫu stop latency chấm theo ngân sách
  50 ms (p50/p95/max, breaches, within-budget rate).
- Báo cáo theo phiên + render markdown cho panel / log.
  Không gọi API ngoài — hypothesis do caller đưa vào.

## 6. Tools voice v4 (9 tool, vào registry)

- `voice_v4_start_session` / `stop_session` /
  `pause_session` / `resume_session` / `set_latency_mode` /
  `latency_report` / `barge_in_test` / `eval_run` /
  `session_log` —
  `packages/tools/src/voiceV4Tools.ts`,
  `createVoiceV4Tools({ getManager })`,
  `VOICE_V4_TOOLS` + `VOICE_V4_TOOL_NAMES`. Tất cả
  `needsApproval: false` (chỉ local, mock mặc định).
- Đăng ký trong coordinator như memory v5 (guarded):
  manager dùng `FileVoiceSessionLogStore` dưới workspace
  (`voice-sessions-v4/`), transport mock mặc định.
- `barge_in_test` mô phỏng model đang nói rồi đưa frame
  loud+VAD giả vào detector, đo thời gian dừng TTS thật.
- `eval_run` chạy fixture mặc định hoặc case caller đưa,
  kèm mẫu stop latency cuối của phiên (nếu có sessionId).

## 7. UI + i18n

- 17 key `voice.realtime.v4.*` × 6 locale (vi/en/zh/ja/
  es/fr), parity 6/6. `voice.realtime.*` tổng 54 → 71 key.
- `RealtimeVoicePanel`: prop optional mới `v4Status`
  (latency mode, turn latency p50/p95/p99, slowest stage,
  jitter buffer, barge-in state, stop ms/budget/breaches,
  partial text, waveform, turn history) + `v4Stages` +
  callback `onLatencyModeChange` / `onBargeInTest` /
  `onResumePartial` + section `data-testid="realtime-v4"`.
  Waveform vẽ từ mock levels cho tới khi IPC đưa mức mic
  thật. Cùng pattern optional-prop như v2/v3/v104 — ChatView
  chưa truyền prop này (nối IPC là việc follow-up).

## 8. File đổi

Mới:

- `packages/core/src/voice/latencyPipeline.ts`
- `packages/core/src/voice/bargeInV4.ts`
- `packages/core/src/voice/voiceSessionV4.ts`
- `packages/core/src/voice/voiceSessionManagerV2.ts`
- `packages/core/src/voice/voiceEval.ts`
- `packages/tools/src/voiceV4Tools.ts`
- `tests/voice-v105.test.mjs`
- `docs/voice-live-v105.md` (file này)

Sửa:

- `packages/core/src/voice/index.ts` — export module mới.
- `packages/core/src/index.ts` — export v4 ra package root
  (tools import từ `@open-bot/core`).
- `packages/tools/src/index.ts` — export `createVoiceV4Tools`.
- `packages/core/src/coordinator/coordinator.ts` — interface
  `createVoiceV4Tools` + đăng ký guarded với manager +
  file log store.
- `apps/desktop/src/renderer/components/RealtimeVoicePanel.tsx`
  — prop + section v4.
- `apps/desktop/src/renderer/i18n/locales/{en,vi,zh,ja,es,fr}.json`
  — 17 key mới mỗi locale.

Không đổi tên/xóa file nào. Không đụng main.ts / preload.ts /
harness / memory / acp / workspace / platform.

## 9. Kiểm chứng

- Build + typecheck xanh: core, tools, desktop, cli.
- `tests/voice-v105.test.mjs`: **21/21 pass** (mock
  transport, fake clock, fake session — không mạng, không
  sound card).
- Hồi quy xanh: voice-v103 + voice-v104 + voice.test +
  voice-p01 (85 test), realtime-ui-v095d3 + voice-live-v096
  + voice-live-v098 + memory-v5-tools-v104 + voice-v102
  (97 test) — tổng 182 test hồi quy + 21 test mới, 0 fail.

## 10. Giới hạn còn lại

- Adapter live chưa verify (như v0.96/v0.98/v1.03): không
  key OpenAI; key Gemini trong connector store, không copy
  — mọi đường live vẫn mock-verified. Live ảnh Gemini
  KHÔNG thử (quota ảnh = 0).
- Mic/loa thật + app Electron thật chưa chạy trên VM
  headless (không sound card). Waveform panel dùng mock
  levels cho tới khi IPC đưa mức mic thật; duck hạ âm
  lượng provider vẫn cần main xử lý event như v1.03.
- Stage latency capture/VAD/STT/LLM/TTS chỉ có số khi
  caller đo được (local stack / test) — session không tự
  tách LLM khỏi TTS trên đường provider.
- Barge-in v4 đo trên đường local; đường server-VAD của
  session vẫn chạy như trước, hai đường không double-cancel
  (v4 chỉ huỷ qua v3).
- Dịch i18n zh/ja/es/fr chưa được người bản ngữ review
  (như các sóng trước).
