# Local-model router v2 (v1.16, Đội T3)

Router kiểu llama.cpp router-mode (từ 12/2025) + llama-swap, viết lại
hoàn toàn cho open-bot. Local-first, miễn phí, không dữ liệu X,
không cloud VM / tài khoản / thanh toán.

## Ý tưởng học được (không copy code/text/tài sản)

- **llama.cpp router mode**: `llama-server` không `-m` → router; route
  theo `model`, load on-demand, LRU unload ở `--models-max`, mỗi model
  một child process riêng (crash một model không kéo sập router),
  `--models-dir` quét GGUF, `--models-preset` INI per-model flags, TTL
  idle unload. Hạn chế đã biết: `--models-max` đếm model chứ không đếm
  VRAM — router v2 khắc phục bằng cách tính theo byte RAM/VRAM thật.
- **llama-swap**: groups quy định model nào chia GPU; "embedder luôn
  resident".
- **OpenMausBot**: engines pluggable trỏ tới CLI binary tùy chỉnh, model
  picker hiển thị provider side-by-side; bài học: không pin CLI thì đổi
  format output là gãy → router v2 có adapter version range + phát hiện
  format lạ (hạ cấp, không crash).

## Module

| File | Nội dung |
| --- | --- |
| `types.ts` | Shared types + `DEFAULT_ROUTER_V2_CONFIG` |
| `discovery.ts` | Quét models-dir, parse header GGUF thật (magic, version, metadata) |
| `presets.ts` | Parser preset INI, validate + clamp, merge flags, build argv llama-server |
| `resourceEstimator.ts` | Footprint GGUF + KV cache, RAM thật (`os`), VRAM (`nvidia-smi`), `ResourceBudget` |
| `processManager.ts` | Mỗi model một child process, crash isolation, restart backoff nhân đôi |
| `lruV2.ts` | LRU + TTL unload theo byte RAM/VRAM, bảo vệ active/resident/min-stay |
| `swapGroups.ts` | Nhóm chia tài nguyên, embedder luôn resident, preemption theo priority |
| `pickerV2.ts` | Chấm điểm task → model (cost/latency/quality), giải thích, nhớ lựa chọn user |
| `cliProbeV2.ts` | Probe sâu 6 CLI (Codex/Claude Code/OpenCode/Gemini CLI/Aider/Cursor CLI) |
| `fallback.ts` | Fallback chain cloud → CLI → local, circuit breaker, health, budget (nối v1.15) |
| `routerV2.ts` | Orchestrator: discovery + load on-demand + route + sweep |
| `architectEditor.ts` | **v1.17** Architect–Editor: planner lập plan, editor thực thi, escalate khi fail |
| `repoMapV4.ts` | **v1.17** Repo map v4: signature (TS/Py dùng parser v8, Go/Rust/Java riêng) + PageRank + budget map |
| `localDetectV2.ts` | **v1.17** Ollama /api/tags + /api/ps, LM Studio /v1/models, hợp nhất CLI probe, toggle nguồn, entries cho model picker |
| `index.ts` | Public exports |

Tools: `packages/tools/src/routerV2Tools.ts` (8 tools, module riêng,
**chưa** nối vào `ALL_TOOLS` — coordinator nối khi gộp để tránh xung
đột với các đội khác).

## Quy tắc router

- **Load on-demand**: kiểm tra RAM/VRAM thật → evict LRU v2 (theo byte)
  → preempt swap-group → spawn child process riêng (`llama-server`,
  host `127.0.0.1`).
- **Evict**: không bao giờ evict model đang chạy task; resident
  (pin / embedder) chỉ evict khi `force`; model mới load được bảo vệ
  bởi `minStayMs` trừ khi user load chủ động (`ignoreMinStay`).
- **Crash**: process chết → chỉ model đó `crashed`/`failed`; restart
  backoff nhân đôi (trần `restartBackoffMaxMs`), tối đa `maxRestarts`
  lần; chạy ổn định ≥ 10s thì reset đếm crash.
- **Picker**: task nhẹ (heaviness ≤ 0.3) → local; task nặng (≥ 0.7) →
  model quality ≥ 0.8; manual override luôn được tôn trọng; lựa chọn
  tay của user được nhớ (boost tối đa +0.12, không lật đổ hoàn toàn).
- **CLI probe**: chỉ probe bằng lệnh của chính CLI; **không bao giờ**
  đọc nội dung credential/token. Gemini chỉ đọc trường email trong
  `google_accounts.json`; Aider chỉ kiểm tra **tên** biến môi trường.
  Format output lạ → `formatStatus='unknown'` + warning, không crash.
- **Fallback**: cloud → CLI → local; circuit breaker mỗi nguồn
  (mở sau 3 lỗi liên tiếp, thử lại sau 60s); budget gate chặn cloud khi
  vượt budget; spend ghi vào `LocalBudgetTracker` v1.15.
- **Architect–Editor (v1.17)**: planner mạnh nhất đạt ngưỡng quality
  theo độ khó; editor rẻ nhất đạt ngưỡng (ưu tiên local); task dễ có
  thể single-model. Editor fail → retry → escalate lên planner →
  đổi editor mạnh hơn → fail có báo cáo. Executor do caller inject
  (test dùng fake); không gọi model thật trong module này.
- **Repo map v4 (v1.17)**: chỉ lấy signature + import, không thân
  hàm; PageRank có trọng số (calls 4 > imports 3 > references 1.5 >
  defines 1) + personalization theo query; render theo budget token
  (chars/4), báo included/omitted/partial. Call resolve theo tên
  ngắn nên method trùng tên có thể nối nhầm (báo trong stats).
- **Local detect v2 (v1.17)**: chỉ gọi HTTP loopback + lệnh của
  chính CLI; **không bao giờ** đọc nội dung credential/token, không
  copy/gửi credential. Ollama tôn trọng `OLLAMA_HOST`, LM Studio
  tôn trọng `LM_STUDIO_URL`. Toggle từng nguồn (`SourceToggleStore`,
  serialize được); model picker entries ghi rõ nguồn + tài khoản.

## Cấu hình

```ts
new LocalModelRouterV2({
  config: {
    modelsDirs: ['~/models'],
    presetPaths: ['~/models/presets.ini'],
    maxLoadedModels: 2,
    maxRamBytes: 0,        // 0 = 80% RAM tổng
    idleTimeoutMs: 600_000,
    maxRestarts: 3,
    restartBackoffBaseMs: 1000,
    restartBackoffMaxMs: 30_000,
    portStart: 18100,
  },
});
```

## Test

```bash
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
node --test tests/router-v116-discovery.test.mjs \
  tests/router-v116-runtime.test.mjs \
  tests/router-v116-picker-fallback.test.mjs \
  tests/router-v116-cli-probe.test.mjs \
  tests/router-v116-tools.test.mjs \
  tests/router-v116-i18n.test.mjs
```

Test dùng mock process/CLI + file GGUF fixture trong `/tmp` — không gọi
CLI thật, không cần GPU/model thật, không gọi mạng.

## i18n

51 key `routerV2.*` × 6 locale (`en/es/fr/ja/vi/zh`), key đã sort,
placeholder khớp `en`. Test: `tests/router-v116-i18n.test.mjs`.

## Giới hạn còn lại

- VRAM chỉ đo được qua `nvidia-smi` (NVIDIA); Apple Silicon / AMD /
  Intel GPU trả `null` → chỉ kiểm tra RAM (không đoán VRAM).
- Health check mặc định gọi `GET /health` trên llama-server thật;
  backend Ollama/custom chưa có adapter spawn riêng (dùng chung đường
  llama-server, host tự gắn spawner qua `ModelProcessManager`).
- CLI probe dựa trên docs công khai 11/2026, chưa chạy trên máy thật có
  CLI đăng nhập (parser phòng thủ: field lạ → `loggedIn: null`).
- `loadModel` chưa stream tiến độ load (chỉ trả kết quả cuối).
