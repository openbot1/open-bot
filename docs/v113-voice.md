# Voice realtime v12 (v1.13, Đội T5)

Mở rộng hệ thống voice v11 — không viết lại: v12 là lớp phủ trên
`RealtimeVoiceSessionV11` (VAD v11, barge-in v11, turn-taking v11,
TTS stream v11), thêm 4 thành phần mới trên cùng một đồng hồ ảo.

## 1. Barge-in: giữ context câu đang dở (`bargeInV12.ts`)

v11 trả receipt chính xác (từ bị cắt, ms đã phát/bỏ) rồi vứt phần còn
lại. v12 giữ lại qua `InterruptContextV12`:

- `recordInterrupt({ receipt, tts, replyText })` → `InterruptedUtteranceV12`:
  `playedText` (đã nghe), `remainingText` (chưa nghe), `cutWord`,
  từ user ngắt lời (feed qua `noteUserWord` từ partial STT),
  `resumeStrategy` + `resumeText` + `resumePrompt` (đoạn system-prompt
  cho model nói tiếp mạch lạc thay vì bắt đầu lại).
- Chiến lược resume: `continue` (phần còn lại ngắn), `restart` (cắt
  quá sớm / còn đang thinking), `summarize` (phần còn lại dài —
  nén thành 1 câu), `drop` (user hỏi việc mới — trả lời user thay vì
  nói nốt câu cũ). `setStrategy()` đổi chiến lược sau khi ghi.

## 2. TTS streaming v12 (`ttsStreamV12.ts`)

`TtsStreamV12` bao `TtsStreamV11` (không thay thế): text delta vào →
chunk đã hoạch định → inner stream phát.

- Biên câu tiếng Việt: tách ở `—`, flush khi buffer kết thúc bằng `…`
  / `—`, bảo vệ viết tắt `TS. BS. ThS. GS. PGS. UBND. HĐND. vd. v.v.`
- Word timings: mỗi chunk có map từ → start/end ms (từ `msPerChar` +
  prosody) — panel highlight đúng từ đang nói, receipt ngắt lời biết
  đúng từ bị cắt.
- Prosody: nghỉ sau `,` 120 ms, `;`/`:` 180 ms, `…` 350 ms, `—` 300 ms.
- Pacing thích ứng: hàng đợi 0–2 chunk ×1.0, 3–5 ×1.05, 6+ ×1.15
  (tối đa `maxPacingFactor`); gợi ý khoảng nghỉ 150 ms khi hết hàng đợi.
- Chunk ưu tiên: `feedUrgent()` (vd. "Vâng, tôi nghe đây.") nhảy lên
  trước text reply đang đệm — user nghe phản hồi ngay sau khi ngắt lời.

## 3. Turn-taking v12 (`turnTakingV12.ts`)

- `TurnMachineV12`: một máy trạng thái thống nhất cho cả cuộc gọi —
  `idle → listening → thinking → speaking → listening`, với
  `interrupted → cooldown → listening` khi bị ngắt lời. Mọi chuyển đổi
  qua bảng guard `TURN_V12_TRANSITIONS`; chuyển sai bị đếm, không áp
  dụng lén. Timeout theo từng trạng thái: im lặng lúc `listening`
  (mặc định 8 s → nudge tối đa 2 lần rồi `call-idle`, không bao giờ
  tự kết thúc cuộc gọi), `thinking` quá lâu (mặc định 30 s →
  `thinking-timeout` về `listening`), cooldown sau ngắt lời (1,5 s).
- `EndOfTurnDetectorV12`: hết lượt khi khoảng lặng sau lời nói đủ
  `trailingSilenceMs` (mặc định 700 ms) sau ít nhất `minSpeechMs`
  (300 ms). Burst rất ngắn → `backchannel` ("ừ"), burst dừng sớm →
  `false-start`, khoảng lặng ngắn → `turn-merged` (nối thành một
  lượt), lượt quá `maxTurnMs` (30 s) → `turn-timeout`.

## 4. Chồng tiếng (`overlapV12.ts`)

- `OverlapTrackerV12`: mở segment khi user nói trong lúc agent đang
  nói; ghi log segment (thời lượng, bên thắng, từ của agent bị mất,
  từ của user, lý do phân xử). Chính sách: `user-wins` (mặc định —
  user luôn được lượt), `agent-keeps` (burst ngắn / thiếu tự tin chỉ
  là backchannel, agent giữ lượt), `confirm` (chờ host phân xử).
- Ducking envelope (`DuckEnvelopeV12`): âm lượng là đường ramp tuyến
  tính từng đoạn — 1.0 → `duckFactor` (mặc định 0.35) trong
  `duckRampMs` (120 ms), giữ khi user nói, về 1.0 trong
  `resumeRampMs` (250 ms) sau khi user dừng. `volumeAt(atMs)` cho
  đúng hệ số tại bất kỳ thời điểm nào.

## 5. Session v12 (`voiceSessionV12.ts`)

`RealtimeVoiceSessionV12` bao `RealtimeVoiceSessionV11`, lái 4 thành
phần v12 từ chính event của v11 (`state`, `vad`, `reply-cut`,
`reply-started`, `tts drained`) trên cùng đồng hồ ảo. `speakReply()`
hoạch định chunk bằng `TtsStreamV12` (word timings + prosody cho
panel) rồi nói qua v11. `resumeReply()` nói tiếp câu dở theo chiến
lược đã ghi (`drop` thì không nói gì — lượt sau trả lời user).
`noteUserWord()` feed từ partial STT vào cả interrupt context và
segment overlap đang mở. `VoiceV12Manager` quản lý nhiều session.

## Tools (`packages/tools/src/voiceV12Tools.ts`)

8 tools, module riêng, **chưa nối vào ALL_TOOLS** (coordinator nối
sau khi merge): `voice_v12_session_create/list/stats/stop/delete`,
`voice_v12_interrupt_context` (xem context + resume),
`voice_v12_overlap_report`, `voice_v12_turn_status`.

## UI

- `apps/desktop/src/renderer/voice/voiceSessionV12View.ts`: view
  model thuần (parse row, overlap rows, interrupt card, planned
  chunk rows + current word, formatters).
- `apps/desktop/src/renderer/components/VoiceSessionV12Panel.tsx`:
  panel presentational (chưa có IPC `voice-v12:*` — host nối sau).
- i18n: 40 key `voice.realtime.v12.*` × 6 locale (vi, en, zh, ja, es, fr).

## Kiểm chứng

```sh
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/voice-v113.test.mjs
```

Mock hoàn toàn (audioMockV11, mock sine TTS, reply scripted).
Không live Gemini (quota ảnh key miễn phí = 0 — không liên quan,
voice realtime dùng mock provider khi không có key thật).
