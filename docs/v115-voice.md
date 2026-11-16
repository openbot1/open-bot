# Voice v14 (v1.15, Đội T5)

Nối tiếp voice v13 (v1.14). Chỉ học ý tưởng từ khảo sát
`docs/repo-survey-v115.md` mục 5 (Deepgram Nova-3/Flux, Cartesia
Sonic, Pipecat Smart Turn v3.1, Pocket TTS, barge-in pattern) —
không copy code/text/tài sản của bất kỳ repo nào.

## 1. Latency budget v2 — `packages/core/src/voice/latencyBudgetV14.ts`

Wrap `LatencyBudgetV13` (global stage reports giữ nguyên) + lớp
per-session trên cùng:

- Stage mới `network` (round-trip tới cloud STT/TTS) — chỉ lưu ở
  v14 vì v13 không có stage này.
- Budget profile: `local` (Whisper + Pocket TTS, e2e 1800 ms,
  network 0), `cloud` (mặc định v13 + network 250 ms),
  `realtime` (speech-to-speech, e2e 700 ms), `custom` + override
  từng stage.
- Alert 2 mức: `warn` (vượt budget), `critical` (vượt
  `criticalFactor × budget`, mặc định 1.5×). Alert v13 được
  re-emit kèm level + session.
- Báo cáo theo phiên: p50/p95/**p99** từng stage, compliance rate
  (tỉ lệ turn đúng ngân sách), worst stage, e2e p50/p95, lịch sử
  alert của phiên.

## 2. Provider pluggable v2 — `packages/core/src/voice/voiceProvidersV14.ts`

Tách interface v13 (STT+TTS chung) thành `SttProviderV14` /
`TtsProviderV14` — provider chỉ-STT (Deepgram) hay chỉ-TTS
(Cartesia, Pocket TTS) không còn phải fake method kia:

- **Deepgram** (Nova-3/Flux): streaming STT partials (interim →
  final), cần key, STT-only.
- **Cartesia** (Sonic): TTS + first-audio metric (90 ms mô hình),
  chunked synthesis, cần key, TTS-only.
- **Whisper local v14**: probe binary/model thật bằng
  `fs.existsSync`; không thấy thì fallback mock engine và
  `isReady() === false` (picker không chọn làm Whisper thật).
  Model size tiny/base/small đổi latency mô hình (120/220/420 ms
  trên 1 s audio).
- **Pocket TTS**: TTS CPU cục bộ kiểu Pocket TTS (~100M param),
  first-audio metric (mặc định 200 ms), không key, luôn sẵn.
- **Realtime API** + **mock** như v13.
- Registry `pick()` theo goal `latency | quality | cost |
  balanced` + filter capability/local-only/no-key-only; `pickPair()`
  chọn cặp STT+TTS tốt nhất; `estimateVoiceProviderV14HourlyCost()`
  tính chi phí/giờ theo mức dùng. `wrapVoiceProviderV13()` cho
  adapter v13 cũ chạy tiếp (không streaming).

## 3. Semantic turn-taking v2 — `packages/core/src/voice/smartTurnV14.ts`

Wrap `SmartTurnDetectorV13`, tái dùng scorer v13 (score + signals
v13 luôn nằm trong kết quả v14):

- Clause boundary: tách mệnh đề ở dấu phẩy/chấm phẩy/hai chấm/liên
  từ; turn kết thúc *giữa* mệnh đề bị giữ lại, kết thúc *tại* ranh
  giới mệnh đề được cộng điểm.
- Câu hỏi mở vs đóng: mở (`nghĩ sao`, wh-word) được chờ thêm
  `openQuestionExtraSilenceMs` (mặc định 400 ms); đóng (`không`,
  `à`, `đúng không`) kết thúc nhanh.
- Filler detection: từ đệm giữa turn (`ừm`, `à thì`, `kiểu`…);
  density ≥ ngưỡng (0.25) nghĩa là user còn đang nghĩ → hold-back.
- Backchannel classification: `ack` (nghe thôi) / `continue`
  (muốn lấy lượt) / `filler` (tiếng nghĩ).
- Sensitivity preset: `low` (kiên nhẫn) / `balanced` / `high`
  (kết thúc nhanh) → bộ ngưỡng + silence.
- Hold-back được kiểm tra **trước** khi detector v13 quyết định
  (nếu không v13 đã reset + đếm nhầm turn); hold-back mid-clause
  tự nhả khi silence vượt ngưỡng incomplete.

## 4. Wake word v2 — `packages/core/src/voice/wakeWordV14.ts`

- Nhiều wake word, mỗi từ một config riêng: `minConfidence`,
  `cooldownMs`, `requireVadConfirm`, `confirmWindowMs`.
- False-positive suppression: hit keyword → `pending-confirm`,
  chỉ thành activation khi VAD xác nhận có speech thật trong
  cửa sổ; hết cửa sổ → suppressed (đếm là false positive).
  Thêm near-miss list (cụm nghe giống keyword nhưng không phải)
  và ngưỡng confidence từng từ.
- `evaluateWakeWordV14(options, samples)`: chạy detector trên
  test set có nhãn, trả TP/FP/FN/TN + false-accept rate +
  false-reject rate, tổng thể và từng keyword.

## 5. Barge-in v2 — `packages/core/src/voice/bargeInV14.ts`

- `StageQueueV14`: queue có giới hạn cho từng stage VAD/STT/LLM/
  TTS, drop policy riêng (`drop-oldest` cho VAD/STT,
  `drop-newest` cho LLM, `reject` cho TTS); đếm enqueue/dequeue/
  drop/reject/flush.
- `VoicePipelineV14`: 4 queue + cancel scope v13; `cut()` flush
  hết, hủy LLM scope, đo **cut latency** (VAD speech-start →
  audio dừng).
- `BargeInEngineV14`: wrap v13 engine; VAD speech-start qua gate
  v13 → flush pipeline → v13 cut + record. `cutMidSentence()`
  tách reply tại số ký tự đã phát (lùi về ranh giới từ, không cắt
  giữa từ; dấu câu là ranh giới) — played giữ lại transcript,
  remainder để resume.

## 6. Session v14 — `packages/core/src/voice/voiceSessionV14.ts`

Wrap `RealtimeVoiceSessionV13`, cùng một virtual clock. Smart
Turn v2 + wake word v2 chạy **song song** với v13 trên cùng
transcript (so sánh được verdict 2 phiên bản). `speakReply`
enqueue LLM/TTS item vào pipeline; `interrupt` cắt v13 trước rồi
v14 (pipeline flush + split giữa câu); `feedAudio` enqueue VAD
item (trừ khi gate v2 đang ngủ thì đếm ignored frame).

## 7. Tools, renderer, i18n

- `packages/tools/src/voiceV14Tools.ts`: 9 tools
  (`voice_v14_session_create/list/stats/stop/delete`,
  `voice_v14_barge_in`, `voice_v14_latency_budget`,
  `voice_v14_wake_word` — có action `evaluate` với test set —,
  `voice_v14_provider` — pick/set theo goal). Đăng ký vào
  `ALL_TOOLS` (500 tools) + `packages/tools/src/index.ts`.
- `apps/desktop/src/renderer/voice/voiceSessionV14View.ts`:
  view model renderer-local (không import `@open-bot/core`):
  parse row/latency (p99 + network)/provider (split caps + pick
  scores)/Smart Turn v2/wake word/pipeline/evaluation + formatter.
- i18n: 50 key `voice.realtime.v14.*` × 6 locale (vi, en, es, fr,
  ja, zh), cùng key set.
- Re-export ở `packages/core/src/voice/index.ts` và
  `packages/core/src/index.ts` (root).

## 8. Test

`tests/voice-v115.test.mjs` — 23 test, xanh. Mock provider/engine
toàn bộ; không mic/loa, không key thật, không network.

## Giới hạn còn tồn tại

- Provider mới là mock adapter của interface (timing + transcript
  kịch bản) như v13 — host muốn audio thật phải gắn adapter live
  sau interface; không có key thật nên Deepgram/Cartesia/Realtime
  chưa từng gọi API thật.
- Whisper local chỉ *probe* binary/model file, chưa chạy inference
  thật (chưa có binary Whisper trên máy này).
- Pocket TTS là mock engine mô hình first-audio, chưa có model
  thật.
- Wake-word matching vẫn trên transcript (mock engine v13), chưa
  có keyword spotter on-device chạy trên audio thô.
- Smart Turn v14 là heuristic xác định, chưa phải model turn-taking
  đã train (thay được sau cùng interface `decide`).
- Cut latency đo trên virtual clock (VAD speech-start → cut),
  chưa đo trên audio thật.
