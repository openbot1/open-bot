# Voice v16 (v1.17, Đội T5)

Nối tiếp voice v15 (v1.16, `packages/core/src/voiceV15/`). Chỉ học ý
tưởng từ khảo sát `docs/repo-survey-v117.md` mục 5 (realtime v4,
speech-to-speech, barge-in, semantic turn-taking, wake-word v4, TTS
streaming v2) — không copy code/text/tài sản của bất kỳ repo nào, của
xAI/Cursor. Mọi audio path đều mock / synthetic, đồng hồ ảo, không
mạng, không sound card, không key.

## 1. Speech-to-speech pipeline v4 — `packages/core/src/voiceV16/s2sV16.ts`

Đường đi đầy đủ mic → STT streaming → agent → TTS streaming → loa,
trên adapter S2S v15 (mock transport):

- `StreamingSttV16`: frame 20 ms vào, partial theo lịch từ (kèm
  timing từng từ), final khi đủ khoảng lặng. Turn chỉ bắt đầu khi từ
  đầu tiên tới — frame im lặng sau một final không tạo turn ma rồi
  phát lại lịch từ.
- `BoundedQueueV16`: FIFO có giới hạn, high-water pause /
  low-water resume, quá đầy thì drop *oldest* (audio live phải luôn
  live) và đếm số drop, không im lặng.
- Backpressure ở cả 3 biên: mic → reply → audio; mỗi biên có event
  `backpressure` / `dropped` riêng.
- Reconnect + resume: rớt giữa turn thì pipeline giữ reply/audio
  (không drain khi đang reconnecting), snapshot resume token
  (turn id, transcript prefix, chunk đã nói, chunk chờ, function
  call chờ); khi nối lại thì gửi lại transcript prefix làm context
  rồi nói tiếp từ chunk chưa nói — không phát lại, không mất turn.
  Hết budget reconnect thì fallback sang pipeline cổ điển (đếm 1
  lần, idempotent).
- Playout chạy trên audio-time cursor: một tick dài phát hết chunk
  nào đã tới hạn thay vì 1 chunk/tick; turn mới bắt đầu thì drop
  audio/reply còn đọng của turn cũ (từng gây `firstAudioMs` âm).

## 2. Barge-in v4 — `packages/core/src/voiceV16/bargeInV16.ts`

Trên detector v15 (energy gate, cough/breath/noise/echo/cooldown):

- Cắt TTS ngay khi xác nhận giọng người (`cutDelayMs` cấu hình
  được, mặc định 0); hook `stopTts` / `discardLlm` do session bind.
- Giữ lại phần đã nói + context: receipt có `spokenText` /
  `spokenChars`, `remainingText`, snapshot turn (`turnId`,
  `userText`, `replyText`); dưới `minSpokenCharsToKeep` thì là cut
  *full*, trên thì *partial*.
- Echo-aware khi TTS đang phát: frame chỉ tính là người nói khi
  vượt mức echo TTS đang phát × `echoMarginRatio` (mặc định 1.6);
  echo yếu không bao giờ cắt được.
- Thu lại lời ngắt: sau cut, text ngắt lời được capture trong
  `captureWindowMs` làm đầu vào turn mới.

## 3. Semantic turn-taking v4 — `packages/core/src/voiceV16/smartTurnV16.ts`

Trên scorer v15 (vi + en): quyết định *khi nào agent được nói*.

- Nói khi câu trọn vẹn (score ≥ ngưỡng) VÀ đã im đủ gap yêu cầu.
- Không cắt câu dở: trailing conjunction, câu hỏi mở, list đang
  dở, filler dày đều *kéo dài* gap chờ — không phải veto: im đủ
  gap (đã kéo dài) thì turn vẫn kết thúc; câu vẫn chưa trọn vẹn
  về ngữ nghĩa thì giữ tới timeout.
- Max-wait timeout (`maxWaitMs`, mặc định 8000 ms): hết chờ thì
  prompt một lần ("đang nghĩ?") rồi kết thúc trong
  `promptWaitMs`; backchannel ("ừ", "yeah") kết thúc ngay.
- Tốc độ nói chỉ tin khi turn đủ dài (`fastSpeakerMinSampleMs`,
  mặc định 2000 ms) — cả câu tới trong một partial trông như nói
  siêu nhanh và từng đòi gap vô hạn; agent vừa hỏi thì chờ thêm
  `questionWaitBoostMs`.
- State machine `idle → listening → holding → ended`, cộng
  `timed-out` / `prompted`; mọi chuyển trạng thái đều là event có
  text, score và lý do giữ.

## 4. Wake-word v4 — `packages/core/src/voiceV16/wakeWordV16.ts`

Trên detector v15 (multi-word, sensitivity, near-miss / low-energy
/ cooldown, confirmation window):

- Nhiều từ cấu hình được, mỗi từ có sensitivity, ngôn ngữ,
  cooldown riêng + nhãn `action` tuỳ chọn.
- Wake + command trong một hơi ("hey bot, thời tiết thế nào?"):
  wake và trả luôn command, không bắt người dùng nhắc lại.
- Ngủ lại sau `sleepAfterSilenceMs` im lặng khi đang thức
  (mặc định 60 s); `sleep()` thủ công; mọi speech activity đều
  hoãn hẹn giờ ngủ.
- Wake-storm guard: quá `maxActivationsPerMinute` lần kích hoạt
  trong một phút thì mute detector `stormMuteMs` thay vì thức dậy
  theo từng tiếng vọng.
- Đánh giá trên tập labelled kế thừa từ v15 (TP/FP/TN/FN, FAR/FRR).

## 5. TTS streaming v2 — `packages/core/src/voiceV16/ttsStreamV16.ts`

- Chunk nhỏ (mặc định 60 ký tự, một nửa v15), tách ở ranh giới
  mệnh đề; chunk đầu phát ngay khi sẵn sàng (không chờ chunk sau).
- Nối mượt: scheduler đặt chunk lên timeline với overlap
  `crossfadeMs` (mặc định 15 ms) nên gap giữa các chunk ≤ 0 theo
  thiết kế; gap đo được (âm = overlap, dương = giật) nằm trong
  stats.
- Underrun: chunk chưa synth xong khi chunk trước phát hết thì đếm
  underrun, chèn silence pad rồi tiếp tục khi chunk tới — không
  phát lại, không bỏ chunk. Chunk đầu chưa sẵn sàng thì chỉ chờ,
  không tính underrun.
- Pause/resume dịch toàn bộ timeline; rate từ voice profile rút
  ngắn/kéo dài mọi chunk; `playingUntilMs` tính theo lịch phát,
  không theo `nowMs` (từng làm chunk phát muộn không bao giờ kết
  thúc).

## 6. Session v16 — `packages/core/src/voiceV16/sessionV16.ts`

Nối tất cả: `idle → connecting → asleep | listening → thinking →
speaking → (interrupted → listening) → closed`. Wake từ asleep
(trần + có command), full turn (transcript → reply → TTS v2),
barge-in giữa lúc nói giữ lại spoken prefix và đánh dấu turn bị
ngắt, auto-sleep sau im lặng, fallback pipeline khi S2S chết.
`VoiceSessionManagerV16` giữ session theo id cho tools.

## 7. Tools + i18n

- `packages/tools/src/voiceV16Tools.ts`: 10 tool `voice_v16_*`
  (create/list/stats/stop/delete/talk/barge_in/s2s/wake_word/tts),
  không gộp vào `ALL_TOOLS` (như v15).
- i18n: 48 key `voice.realtime.v16.*` × 6 locale
  (vi/en/es/fr/ja/zh), cùng key set, không chuỗi rỗng.
- Test: `tests/voice-v117.test.mjs` — 44 test, pass 44/44.
  Hồi quy `tests/voice-v116.test.mjs` vẫn 40/40.
- Build + typecheck `@open-bot/core` và `@open-bot/tools` xanh.
