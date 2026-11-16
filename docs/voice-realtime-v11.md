# Voice realtime v11 (v1.12, Đội T5)

Barge-in, turn-taking, VAD theo xác suất và TTS streaming — tiếp nối
voice v10 (pipeline v2 + VAD v10 + barge-in v9). MOCK-ONLY: không gọi
API thật, không đọc key, không chạm sound card.

## Thành phần mới (`packages/core/src/voice/`)

| Module | Việc làm |
|---|---|
| `audioMockV11.ts` | Nguồn mock audio duy nhất cho v11: PRNG seeded (`mulberry32`), frame silence/tone/noise/speech-like/hum/hiss/echo, `buildMockAudioScript` ráp script có label. |
| `vadV11.ts` | VAD theo xác suất (0..1) từ 3 thành phần: năng lượng 2 dải, ZCR fit, high/low ratio fit. Hysteresis (start 0.6 / stop 0.35), hiệu chuẩn 25 frame đầu, gộp khoảng lặng (`mergePauseMs`), ép kết thúc lượt dài (`maxTurnMs`). Sàn nhiễu chỉ học từ frame plausibly là ồn phòng (trong 3× sàn) và bị kẹp trong [0.25×, 10×] sàn ban đầu — học cả frame hum/hiss sẽ làm detector điếc (bug đã gặp khi test). |
| `bargeInV11.ts` | State machine tường minh: `idle → listening → thinking → speaking ⇄ ducked`, `interrupted → cooldown → listening`. Mọi chuyển đổi qua bảng guard, chuyển sai bị đếm + log. Policy mới `smart` (mặc định): chỉ ngắt khi đủ tự tin (≥ 0.7) và đủ dài (≥ 200 ms); burst ngắn mà chắc thì duck, không chắc thì bỏ qua. Receipt có latency ngắt lời (VAD speech-start → interrupt). Cooldown neo vào thời điểm interrupt, không neo vào tick. |
| `turnTakingV11.ts` | Quản lý lượt nói: ai giữ floor (`idle/user/agent/thinking/overlap`), overlap khi user chen vào lúc agent đang nói + resolve tường minh, silence timeout → nudge (tối đa 2) → `call-idle`, ép kết thúc lượt quá dài, gợi ý yield khi năng lượng cuối lượt agent rơi liên tục, đo latency chuyển lượt (mean/p50/p95/max). |
| `ttsStreamV11.ts` | TTS streaming: text delta → chunk ở biên câu (≥ `minChunkChars`, ≤ `maxChunkChars`, bảo vệ viết tắt, câu ngắn tích lũy), synth mock xác định (sine, tần số theo hash text), phát trên virtual clock, pause/resume, `cancelPending()` trả receipt (chunk đã hủy, ký tự chưa nói bị bỏ, ms đã phát/bỏ). Final flush tách câu trước rồi mới gom đuôi. |
| `voiceSessionV11.ts` | Session nối 4 thành phần trên một virtual clock. `feedAudio()` → VAD → barge-in (re-decide mỗi 100 ms khi user còn nói, để policy `smart` kịp cắt) → turn manager → TTS. Speech-end → auto mock reply → drain → listening. VAD và session dùng 2 clock khác nhau nên mọi timestamp VAD được dịch qua `clockOffsetMs` (session − VAD), nếu không `tick()` sẽ làm lệch latency ngắt lời. |
| `voiceSessionV11Store.ts` | Snapshot bền vững: turns + cut point (barge-in + TTS receipt) + stats, ghi atomic + SHA-256, file hỏng bị quarantine (`.corrupt`), `prune()` giữ tối đa 50 file. |

## Luồng một lượt nói

```
mic frame → VadV11 → speech-start → TurnTaking (user turn)
                              └→ BargeInV11 (smart: duck hay cắt?)
                                   └→ cắt: TtsStream.cancelPending()
speech-end → turn ends → thinking → speakReply(text)
                              └→ TTS chunk stream → drained → listening
im lặng 8s → silence-timeout → nudge ("Bạn còn đó không?") ×2 → call-idle
```

## Tools (`packages/tools/src/voiceV11Tools.ts`, 8 tools)

`voice_v11_session_create/list/stats/stop/delete`, `voice_v11_feed_text`
(delta + `final`, hoặc `replyText` để nói cả câu trả lời),
`voice_v11_interrupt`, `voice_v11_vad` (status / đổi preset live).
Đã nối vào `ALL_TOOLS` (placeholder) + binding `getVoiceV11Manager`
trong `createDefaultTools` theo đúng mẫu v10.

## Renderer (`apps/desktop/src/renderer/voice/voiceSessionV11View.ts`)

View model thuần (không import core): parse row session, VAD probability
bar (silent/maybe/speech), barge-in receipt, turn rows, TTS chunk rows
kèm progress, turn-taking/TTS stats, `voice.v11.status.*` keys.

## i18n

30 key `voice.realtime.v11.*` × 6 locale (vi, en, zh, ja, es, fr),
tổng 4595 key/locale.

## Test

`tests/voice-v112.test.mjs` — chạy sau khi build core + tools:

```
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/voice-v112.test.mjs
```

## Giới hạn còn tồn tại

- Không có sound card trên VM nên mọi audio đều là mock; TTS synth là
  sine theo hash text, không phải giọng thật.
- Echo tail sau khi agent dừng nói có thể thành lượt ảo nếu host không
  đánh dấu frame echo (`feedAudio(frame, { echo: true })`).
- TTS timestamps (`readyAtMs`, `startedAtMs`) chạy trên playback clock
  của stream, không phải session clock.
- `speakReply` chỉ nhận khi máy đang `listening`; gọi lúc đang nói
  trả `false` thay vì xếp hàng.
- Live provider chưa nối: session chỉ chạy mock reply + mock synth;
  host muốn live phải inject synth/transport riêng (không làm trong sóng này).
