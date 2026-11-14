# Voice realtime v3 + multimodal — v1.03 (Đội T5)

Nâng cấp voice realtime trên nền v1.02 (long session, media
context, local stack, barge-in v2): phiên dài bền (checkpoint +
resume + reconnect có quyết định), media context sâu (audio +
video frames + tham chiếu trong lời nói), local voice stack mở
rộng (registry + fallback chain + Vosk/Piper/command engines),
barge-in v3 (backchannel + duck + adaptive grace). Test:
`tests/voice-v103.test.mjs` — **38/38 pass**.

## 1. Long session bền — checkpoints + resume (`sessionCheckpoint.ts`, `sessionResilience.ts`)

- `VoiceSessionCheckpoint` (version 1): long-session snapshot
  (turns + summaries), media (metadata + description, **không
  byte** — `bytesOmitted: true`), barge-in counters + partial
  turns, turn count, base instructions, provider, seq, reason.
  Checkpoint từ version khác / session khác bị `restore()` từ
  chối, không áp nửa vời.
- `SessionCheckpointer`: checkpoint mỗi N turn (mặc định 10) /
  mỗi N ms (mặc định 60 s) / ép buộc khi summary, media, manual,
  disconnect. `skippedNoChange` đếm lần hỏi mà chưa tới lúc lưu.
- `MemoryCheckpointStore` (tests + fallback) và
  `FileCheckpointStore` (`~/.open-bot/voice-checkpoints/`, ghi
  atomic tmp + rename, file hỏng → null + quarantine
  `.corrupt-<ts>`, prune 30 ngày / 50 file — cùng kỷ luật như
  `VoiceSessionStore`).
- `ReconnectController`: quyết định redial (backoff nhân đôi +
  jitter 0.2 qua `Backoff`, cap 10 s, tối đa 5 lần/drop), lỗi
  terminal không retry, `noteGoAway()` là reconnect *có kế hoạch*
  (delay 500 ms khi sắp hết / 2 s khi còn nhiều thời gian, không
  tốn budget). `ResilientDialer` chạy vòng lặp quanh `dial()`
  với `sleep` inject được — test không dùng timer thật.
- `buildResumeInstructions()`: base + context block + media block
  + ghi chú "cuộc gọi bị ngắt, tiếp tục từ summary — đừng khởi
  động lại, đừng tự giới thiệu lại". Socket luôn dial mới —
  checkpoint khôi phục *context*, không khôi phục kết nối.

## 2. Media context sâu (`mediaConversation.ts`)

- **Audio media**: gắn bản ghi (`audio/pcm` / WAV — header WAV
  được strip bằng `stripWavHeader()` thuần túy). mp3/aac bị từ
  chối rõ ràng (máy này không có decoder) thay vì transcribe
  sai. Transcribe qua `AudioTranscriber`: `MockAudioTranscriber`
  (không tai, trung thực) hoặc `LocalSttAudioTranscriber` (bọc
  mọi `LocalSttEngine` — whisper-cli, fallback chain). Transcript
  rỗng = failed, không phải turn rỗng lặng lẽ.
- **Video frames**: tối đa 8 frame/video, mỗi frame có timestamp
  (giây) + caption, describe qua cùng `MediaDescriber` với ảnh.
  Quá cap bị từ chối, không drop lặng lẽ.
- **Tham chiếu trong lời nói**: `resolveReference()` — theo tên
  file (high), số thứ tự ("the second image", "ảnh thứ hai",
  "media 2" — medium), từ khóa ("this photo", "ảnh này", "that
  video", "đoạn ghi âm này" — low/medium), "the screenshot" ưu
  tiên item thực sự tên screenshot. Không khớp → null, không đoán.
  `linkTurnToMedia()` gắn media id vào turn của long session.
- **Q&A theo item**: mỗi item giữ lịch sử Q&A riêng
  (`getItemHistory`, tối đa 10) — câu follow-up thấy câu trả lời
  trước ("and which file was that?" → "(Earlier questions…: 2.)").
  Audio trả lời từ transcript; chưa transcribe thì nói rõ.
- **Block theo ngân sách**: `buildConversationBlock()` cap mặc
  định 4000 ký tự; quá ngân sách thì trim dòng 240 → 120 ký tự
  rồi mới bỏ dòng cuối (section mới — audio/frames — giữ label,
  không bị cắt nguyên khối).
- Snapshot/restore: bytes bị strip (transcript + description còn),
  thứ tự gắn được rebuild từ `addedAt` (xấp xỉ — snapshot không
  lưu thứ tự).

## 3. Local voice stack mở rộng (`localVoiceEngines.ts`)

- `LocalVoiceEngineRegistry`: descriptor nào cũng có `probe()` +
  `createStt/createTts`. `pickChain(kind, preferredIds)` trả
  engine khả dụng theo thứ tự: preferred trước, rồi priority.
  Probe chỉ quét PATH + kiểm tra file model — không chạy audio,
  không mạng.
- Engine mới (đều probe thật, không giả vờ có):
  - STT: `VoskSttEngine` (`vosk-transcriber -i <wav> -m <model>`,
    parse JSON `{"text"}`), `CommandSttEngine` (CLI bất kỳ do
    user cấu hình: wav vào, transcript ra stdout, parse text /
    json-text).
  - TTS: `PiperTtsEngine` (`piper --model <onnx>` → WAV → phát
    bằng aplay/ffplay/paplay; chỉ `available` khi đủ cả 3),
    `CommandTtsEngine` (CLI bất kỳ, exit 0 = đã nói).
  - Có sẵn: whisper-cli (probe qua `detectLocalStt()`),
    system-tts (một entry — `SystemTtsEngine` tự chọn binary đầu
    PATH nên 5 entry riêng sẽ thử cùng một engine 5 lần), mock.
- `FallbackSttEngine` / `FallbackTtsEngine`: thử theo thứ tự,
  ghi lại từng attempt (engine, ok, ms, error); hết chain thì
  lỗi nêu tên mọi engine đã thử — không bao giờ trả transcript
  đoán hay im lặng giả vờ đã nói. `fallbacksUsed` đếm lần phải
  dùng engine sau engine đầu.
- Đo trên máy này (`detectLocalVoiceEngines`): STT chain
  `whisper-cli → mock-stt`, TTS chain `system-tts → mock-tts`;
  vosk/piper `available: false` (không có binary/model).

## 4. Barge-in v3 (`bargeInV3.ts`)

- **Backchannel**: transcript ≤ 3 từ, mọi từ trong tập khẳng
  định (en + vi: uh-huh, yeah, mm-hm, right, ok, ừ, ừm, vâng,
  đúng rồi…) → noted, model nói tiếp, không cancel. Không có
  transcript thì không đoán backchannel — đi đường v2.
- **Soft interrupt (duck)**: opt-in (`softInterrupt: true`). Ngắt
  lần đầu chỉ *duck* (dừng TTS local + emit `ducked` để main hạ
  âm lượng provider); `confirmDuck(true)` khi user nói tiếp →
  interrupt thật; `confirmDuck(false)` khi user dừng → rollback
  đúng bằng `BargeInController.cancelPendingInterrupt()` (mới
  trong v2 — unwind interrupt count + drop measurement đang bay,
  không để lại phantom barge-in trong stats).
- **Adaptive grace**: grace-ignore rồi interrupt lại trong 2 s
  (user phải lặp lại vì grace quá dài) → đếm; 3 lần → grace −100
  ms (floor 200 ms). Báo trong stats (`graceAdaptations`).
- `buildResumePrompt(partial, policy)`: resume → "tiếp tục đúng
  chỗ đã dừng"; restart → "đừng lặp lại, chờ user". Partial dài
  trim 500 ký tự.
- V2 controller vẫn sở hữu timing (meter 500 ms) + partial turns
  — v3 chỉ thêm lớp *quyết định*.

## 5. VoiceSessionV3 (`voiceSessionV3.ts`)

- Bọc `VoiceSessionV2`: v2 được ép `bargeInGraceMs: 0` /
  `bargeInMinSpeechMs: 0` — v3 sở hữu toàn bộ gating ở đường
  local/manual, v2 chỉ thực thi cancel. Đường server-VAD của
  session giữ nguyên.
- Media chỉ sống trong `MediaConversation` (không dùng media
  context riêng của v2 — một store, không hai). `connect()` gửi
  base + media block; v2 append long-session block.
- Checkpoint tự động: final transcript / turn xong / summary /
  media attach; `disconnect()` checkpoint reason `disconnect`
  trước khi ngắt. `resume(checkpoint?, config?)` khôi phục long
  session + media conversation rồi redial bằng
  `buildResumeInstructions` (config mới cho trường hợp app
  restart — wrapper chưa từng connect). Resume khi đang connected
  là no-op; resume không checkpoint là null.
- `noteUserSpeechV3()` / `confirmDuck()` / `interruptV3()`;
  event mới: `checkpoint`, `resumed`, `resume-failed`,
  `backchannel`, `ducked`, `duck-cancelled`, `barge-in-v3`,
  `reconnecting`. Barge-in counters restart ở 0 sau resume —
  counters trong checkpoint báo ở `getV3Stats().restored`, không
  cộng vào live.
- `createToolHandlers()`: handler cho 2 tool voice-call mới
  (xem §6) để bind vào `createVoiceCallToolSet`.

## 6. Voice-call tools mới (12 thay vì 10)

- `save_checkpoint` — model yêu cầu lưu checkpoint giữa cuộc gọi
  (handler: `checkpointNow('manual')`, trả `{saved, seq,
  turnCount, mediaItems, at}`).
- `recall_media` — model hỏi về media đã gắn bằng tham chiếu
  ("this photo", "the second image") + câu hỏi (handler:
  resolve → `askAboutMedia`, trả `{found, itemId, kind,
  confidence, answer}`).
- Voice-call tools vẫn cố tình KHÔNG vào `ALL_TOOLS` (cô lập cấu
  trúc như v0.95 — xem `callTools.ts`); 2 tool mới đăng ký vào
  đúng voice-call toolset (`VOICE_CALL_TOOL_DEFINITIONS` +
  `VoiceCallToolName`). Test cập nhật: `voice-p01` (12 tools),
  `voice-surface-v056` (12 tools trong instructions).

## 7. UI + i18n

- 14 key `voice.realtime.v3.*` × 6 locale (vi/en/zh/ja/es/fr);
  `voice.realtime.*` tổng 40 → 54 key, parity 6/6 (test
  `realtime-ui-v095d3` cập nhật 40 → 54 + liệt kê key v3).
- `RealtimeVoicePanel`: prop optional mới `v3Status`
  (`RealtimeV3Status`: checkpoints, lastCheckpointSeq, resumed,
  reconnectAttempt/Max, backchannels, audioMedia, videoFrames,
  graceMs, sttEngines, ttsEngines, fallbackEngine) + section
  `data-testid="realtime-v3"`. Cùng pattern optional-prop như v2
  — ChatView/main chưa truyền prop này (nối IPC là việc follow-up
  cho coordinator; panel không đổi khi thiếu prop).

## 8. File đổi

Mới:

- `packages/core/src/voice/sessionCheckpoint.ts`
- `packages/core/src/voice/sessionResilience.ts`
- `packages/core/src/voice/mediaConversation.ts`
- `packages/core/src/voice/localVoiceEngines.ts`
- `packages/core/src/voice/bargeInV3.ts`
- `packages/core/src/voice/voiceSessionV3.ts`
- `tests/voice-v103.test.mjs`
- `docs/voice-live-v103.md` (file này)

Sửa:

- `packages/core/src/voice/mediaContext.ts` — `RestorableMediaItem`
  + `snapshotItems()` / `restoreItems()` (khôi phục media từ
  checkpoint, description còn, bytes không).
- `packages/core/src/voice/bargeInV2.ts` —
  `cancelPendingInterrupt()` (rollback cho duck bị hủy).
- `packages/core/src/voice/voiceSessionV2.ts` — `noteModelTurn()`
  (ghi model turn không qua transport, cho media answer).
- `packages/core/src/voice/types.ts` — 2 tool `save_checkpoint`,
  `recall_media` (12 tools).
- `packages/core/src/voice/callTools.ts` — comment 10 → 12.
- `packages/core/src/voice/index.ts` — export module mới.
- `apps/desktop/src/renderer/components/RealtimeVoicePanel.tsx` —
  prop + section v3.
- `apps/desktop/src/renderer/i18n/locales/{en,vi,zh,ja,es,fr}.json`
  — 14 key mới mỗi locale.
- `tests/voice-p01.test.mjs`, `tests/voice-surface-v056.test.mjs`,
  `tests/realtime-ui-v095d3.test.mjs` — cập nhật số lượng (12
  tools / 54 key).

Không đổi tên/xóa file nào. Không đụng main.ts / preload.ts /
harness / memory / acp / workspace / platform.

## 9. Kiểm chứng

- Build + typecheck xanh: core, tools, desktop (renderer + main).
- `tests/voice-v103.test.mjs`: **38/38 pass** (mock transport,
  fake runner, fake clock — không mạng, không sound card).
- Hồi quy xanh: `voice-p01` + `voice-surface-v056` +
  `voice-v102` + `voice.test` (67 test), `voice-live-v096` +
  `voice-live-v098` + `realtime-ui-v095d3` + `voice-v059` +
  `tts-voice-v082` (87 test).

## 10. Lỗi thật bắt được trong sóng này

1. `SessionCheckpointer.skippedNoChange` không bao giờ tăng —
   logic "không due thì return" chạy trước nhánh đếm skip. Sửa:
   đếm skip khi đã có checkpoint mà lần hỏi chưa tới lúc lưu.
2. `MediaConversation.askAboutMedia()` không itemId ưu tiên audio
   thay vì item mới nhất (cả hai đều gắn trong cùng 1 ms nên
   so `addedAt` hòa). Sửa: track `attachOrder` theo thứ tự gắn
   thật, không suy từ timestamp.
3. `VoiceSessionV3.getV3Stats().media.answers` không đếm Q&A của
   audio (chỉ đếm history của image/video). Sửa: cộng cả history
   của audio items.
4. Over-budget trim của conversation block cắt section mới
   (audio) trước vì nó đứng cuối. Sửa: trim dòng 240 → 120 ký tự
   trước, chỉ bỏ dòng cuối khi vẫn quá ngân sách.
5. `VoiceSessionV3.askAboutMedia()` ghi trùng user turn (gọi cả
   `noteUserTurn` của v3 lẫn của v2). Sửa: chỉ ghi một lần qua v3
   + `noteModelTurn()` mới của v2 cho answer.

## 11. Giới hạn còn lại

- Adapter live chưa verify (như v0.96/v0.98): không key OpenAI;
  key Gemini trong connector store, không copy — cả 2 adapter
  vẫn mock-verified. Live ảnh Gemini KHÔNG thử (quota ảnh = 0).
- Whisper tiny trên VM 1.5 CPU chậm (13–65 s/câu 3–4 s, xem
  v0.98); Vosk/Piper chưa có binary/model trên máy nên chỉ
  probe + fake-runner verified, chưa chạy thật.
- Mic/loa thật + app Electron thật chưa chạy trên VM headless
  (không sound card). Duck của provider audio cần main hạ âm
  lượng khi nhận event `ducked` — panel + IPC nối sau.
- `VoiceSessionV3.resume()` dùng khi session đã disconnected;
  redial nội bộ của session (Gemini 5 lần) vẫn chạy song song
  trong lúc connected — v3 dialer chỉ chạy khi đã settled.
- Barge-in counters restart ở 0 sau resume (chỉ báo restored).
- Dịch i18n zh/ja/es/fr chưa được người bản ngữ review (như các
  sóng trước).
