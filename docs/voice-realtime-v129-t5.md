# Voice realtime v20 — sóng v1.29 (Đội T5)

Nối tiếp prosody TTS v5 của v1.28: session persistence/resume bền vững,
eval harness mở rộng và open-turn improvements. Tất cả offline, mock,
đồng hồ ảo — không key, không mạng, không mic.

## Port từ merge/v128 (nội bộ cùng repo)

`merge/v129` fork từ `merge/v120` nên chưa có voiceV19 (v1.27) và voiceV20
(v1.28). Sóng này port nguyên trạng từ `merge/v128`:

- `packages/core/src/voiceV19/` — session manager, prosody, eval, open-turn resume
- `packages/core/src/voiceV20/` — jitter, VAD v7, transcript reconcile,
  barge-in v7, TTS prosody v5, providers failover, reconnect, metrics,
  pipeline, session manager
- `packages/tools/src/voiceV19Tools.ts` (13 tools), `tests/voice-v127.test.mjs`,
  `tests/voice-v20-pipeline-v128.test.mjs`, i18n `voice.v128.*` (14 keys × 6 locale)

Bù thiếu sót của v128 (ghi chú trong code): export `voiceV20` ở core index
(v128 chỉ export V19 — đã kiểm tra không xung đột tên giữa 2 barrel),
export V19 tools ở tools index, và spread `VOICE_V19_TOOLS` vào `ALL_TOOLS`
(v128 ghi "not spread … pinned counts").

## Mới trong v1.29

| Module | Nội dung |
|---|---|
| `sessionPersistenceV20` | Checkpoint durable: envelope JSON versioned + checksum FNV-1a (canonical key-sorted), ghi atomic tmp+rename, retention/prune, chặn path traversal, chế độ memory-only |
| `resumeV20` | Orchestrator resume/restart/summarise/drop theo hình dạng vết cắt; prosody carry-over qua vết cắt; multi-drop + backoff tái dùng reconnect v20; tối đa 3 lần thử |
| `openTurnV20` | Phân loại khoảng lặng (thinking/trailing/listening; filler + liên từ vi/en); chấm điểm barge-in v8 (speaker-change, echo window, backchannel); ngắt câu giữa chừng ở biên từ; phân xử chồng lấn |
| `transcriptAccuracyV20` | WER/CER + alignment Levenshtein cấp từ, phân tích confusion, aggregate mean/p95/pass rate |
| `prosodyEvalV20` | Chấm contour/emphasis/pause/rate của plan TTS v5 so với script kỳ vọng; `renderScriptReplyV20` render reply text từ script |
| `evalCorpusV20` | Corpus offline: 6 dialogue vi/en, 12 cặp transcript, 6 script prosody, 6 scenario turn; tự kiểm tra |
| `evalHarnessV20` | Harness mở rộng: transcript + prosody + turn-taking + barge-in P/R/F1 + chạy dialogue thật qua `VoicePipelineV20` + regression gate so với baseline |

## Tools mới (8, đã đăng ký vào `ALL_TOOLS`)

`voice_v20_persist_save`, `voice_v20_persist_load`, `voice_v20_persist_list`,
`voice_v20_persist_delete`, `voice_v20_resume`, `voice_v20_open_turn`,
`voice_v20_transcript_accuracy`, `voice_v20_eval_extended`.
Cộng 13 tools V19 đã wiring → `ALL_TOOLS` tăng 21 so với base (xem test
pin trong `tests/voice-v129-t5-tools-i18n.test.mjs`).

## i18n

- Port `voice.v128.*`: 14 keys × 6 locale
- Mới `voice.v129.*`: 20 keys × 6 locale (en/es/fr/ja/vi/zh)
- Tổng vi.json: 6652 → 6686 keys

## Test

- `tests/voice-v129-t5-persistence.test.mjs` — envelope/checksum, store
  memory + disk (file thật, mở lại bằng instance mới), resume decisions +
  orchestrator
- `tests/voice-v129-t5-eval.test.mjs` — WER/CER, prosody script, corpus,
  barge-in F1, pipeline dialogue, harness full run + regression gate
- `tests/voice-v129-t5-openturn.test.mjs` — silence, barge-in v8,
  sentence cut, overlap, engine
- `tests/voice-v129-t5-tools-i18n.test.mjs` — 8 tools V20 + 13 tools V19,
  ALL_TOOLS wiring, i18n 6 locale
- Ported: `tests/voice-v127.test.mjs`, `tests/voice-v20-pipeline-v128.test.mjs`

## Giới hạn còn lại

- Mọi audio đều mock/synthetic; chưa có provider live, chưa thử live
  (không thử live ảnh Gemini — key miễn phí quota ảnh = 0).
- Resume/summarise dùng luật + tóm tắt trích câu, chưa dùng model thật.
- Prosody eval chấm plan text (pitch/rate/pause theo kế hoạch), chưa chấm
  audio render thật.
- `ALL_TOOLS` pin 604 ở `tests/coding-v2-tools.test.mjs` và
  `tests/agent-teams-v3-v111.test.mjs` đã stale từ T3 v129 (+6 coding v14);
  cần cập nhật theo số đo thật sau build (xem báo cáo sóng).
