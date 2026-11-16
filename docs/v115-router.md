# Local model router — v1.15 (Đội T3)

> Ý tưởng học từ llama.cpp router-mode (một process quản nhiều model,
> route theo `model`, load on-demand, LRU unload ở `--models-max`) và
> LiteLLM gateway pattern (virtual keys, budgets, spend tracking) trước
> endpoint chỉ listen `127.0.0.1`. Toàn bộ code viết lại cho open-bot,
> không copy code/text/tài sản của repo nào.

## Thành phần

| Module | File | Vai trò |
|---|---|---|
| Catalogue | `packages/core/src/models/localCatalog.ts` | 12 model Qwen3/Llama/Gemma (GGUF), license rõ, RAM/context/use-case |
| Types | `packages/core/src/router/local/types.ts` | Type chung + `formatBytes`/`formatUsd`/`isLoopbackUrl` |
| LRU + RAM | `packages/core/src/router/local/lru.ts` | `RamTracker` (budget 80% RAM tổng), `LruModelCache` (max-models, max-RAM, idle sweep) |
| Registry | `packages/core/src/router/local/registry.ts` | `LocalModelRegistry`: Ollama + llama.cpp, load on-demand, health check, backoff |
| Policy | `packages/core/src/router/local/policy.ts` | `PolicyRouter`: scoring cost/latency/quality + override + fallback |
| Budget | `packages/core/src/router/local/budget.ts` | `LocalBudgetTracker`: virtual key, budget ngày/tháng, spend, rate limit |
| Gateway | `packages/core/src/router/local/gateway.ts` | `LocalGateway`: loopback-only, auth key, budget gate, fallback chain |
| Mock server | `packages/core/src/router/local/mockServer.ts` | `MockOllamaServer` / `MockLlamaCppServer` cho test |
| Tools | `packages/tools/src/routerLocalV115Tools.ts` | 10 tool, đăng ký trong `ALL_TOOLS` |
| i18n | `apps/desktop/src/renderer/i18n/locales/*.json` | 26 key `routerLocal.*` × 6 locale |
| Test | `tests/router-local-v115*.test.mjs` (4 file) | 51 test, node:test, không cần GPU/model thật |

## Catalogue + license

- 12 model: Qwen3 0.6B/1.7B/4B/8B/14B/32B (Apache 2.0), Llama 3.2
  1B/3B + Llama 3.1 8B (Meta Llama Community License), Gemma 3
  1B/4B/12B (Gemma Terms of Use).
- `validateModelLicense()` chạy **trước khi** tải/cài: license không rõ
  hoặc chưa phê duyệt → chặn. Apache/MIT → cho phép, không cảnh báo;
  Llama/Gemma → cho phép + cảnh báo đọc điều khoản.
- Model mặc định fleet: `qwen3-4b` (2.5 GB GGUF, 4.5 GB RAM, 32k ctx);
  model decision/router tier: `qwen3-0.6b`.

## Registry

- **Ollama**: ping `GET /api/tags`, kiểm tra tag có sẵn, thiếu thì
  `ollama pull <tag>` qua spawner, rồi mới đánh dấu loaded.
- **llama.cpp**: spawn `llama-server -m <gguf> --port <port> --host
  127.0.0.1 -c <ctx>` (mỗi model một process riêng), đợi `/health`
  tối đa 30s. Port cấp từ 12100 tăng dần.
- Endpoint trả về là **native base** (`http://127.0.0.1:<port>`, không
  `/v1`); `chatCompletionsUrl()` append `/v1/chat/completions`
  (trả cả `/v1` sẽ bị double `/v1/v1` — lỗi đã gặp và sửa khi test).
- Load thất bại 3 lần liên tiếp → backoff 60s. `beginTask`/`endTask`
  bảo vệ model đang chạy task khỏi LRU/unload. `pin` giữ model.
- Spawner + HTTP client đều inject được → test dùng spawner giả +
  mock server, không cần GPU/model thật.

## LRU theo RAM

- `LruModelCache.planEviction()`: vượt `maxLoadedModels` (mặc định 2)
  → unload LRU trước; vượt `maxRamBytes` → unload model **lớn** trước
  (giải phóng đủ RAM với ít lần unload nhất). Model pin/active không
  bao giờ bị chọn — thiếu chỗ thì load báo lỗi rõ ràng thay vì giết
  task đang chạy.
- `planIdleSweep()`: unload model idle quá `idleTimeoutMs` (mặc định
  10 phút). `RamTracker` mặc định budget 80% RAM tổng.

## Policy router

Thứ tự quyết định trong `PolicyRouter.decide()`:

1. **Manual override**: user chỉ định model → luôn tôn trọng (nếu đủ
   khả năng); không đủ khả năng/không đúng kind → route bình thường
   và ghi rõ lý do.
2. **Task nặng + qualityNeed ≥ 0.85** → bắt buộc cloud.
3. **Task nhẹ (heaviness < 0.5)** + có local đủ khả năng → local tốt
   nhất (cold start 3–10s chỉ trả 1 lần; local rẻ + riêng tư).
4. Còn lại: scoring `0.4·cost + 0.3·latency + 0.3·quality` (chuẩn hoá
   theo max trong nhóm ứng viên). Fallback: cùng kind trước (local →
   local nhỏ hơn), rồi khác kind.
5. Không ứng viên nào đủ khả năng → fallback cứng về cloud rẻ nhất
   (`gemini-2.5-flash`).

Lưu ý trung thực: khi chưa có model nào loaded, cold-start penalty
làm local thua cloud rẻ (gemini-flash) trên bảng scoring thuần —
luật (3) tồn tại chính vì vậy: task nhẹ vẫn đi local theo đúng chính
sách sản phẩm, không để latency nhất thời lật quyết định.

## Budget + spend

- `LocalBudgetTracker`: budget ngày/tháng (global + per-bot), ghi spend
  theo từng call (`token × giá cấu hình`), trạng thái
  `ok | warning (≥ warnAt, mặc định 80%) | exceeded | unlimited`,
  `gate()` chặn call mới khi vượt (trừ khi `blockOnExceed=false`).
- Virtual key (`obk_...`): tạo 1 lần, chỉ lưu hint; `resolveKey`,
  `revokeKey`, hết hạn; **budget của key được gateway enforce độc lập**
  với budget bot (`keyStatus`/`spentForKey`).
- Rate limit đơn giản theo key/phút. `report()` tổng hợp theo model/
  bot + tách local/cloud. `toJSON`/`fromJSON` để host persist
  (secret không persist ở đây — host lưu vào Vault).
- Giá mặc định: local $0.0001/1k token; cloud theo bảng
  `DEFAULT_CLOUD_PRICES` (grok-4.7 $0.003, gemini-2.5-flash $0.0003…).

## Gateway

- `LocalGateway.start()` từ chối nếu Ollama baseUrl không loopback.
- Luồng chat: auth key → budget key → rate limit → budget bot →
  route → gọi local (load on-demand) / cloud (`cloudChat` do host
  inject) → ghi spend cho backend phục vụ thật → thử fallback theo
  thứ tự khi lỗi.
- Chưa có `cloudChat` thì route cloud báo lỗi rõ ràng, không đoán mò.

## Tools (10)

`router_local_catalog_list`, `router_local_catalog_validate`,
`router_local_model_load`, `router_local_model_unload`,
`router_local_model_status`, `router_local_route_decide`,
`router_local_budget_set`, `router_local_budget_report`,
`router_local_spend_record`, `router_local_gateway_key_create`.
Tất cả trả `Error: ...` thay vì throw khi arg sai hoặc backend chết.
State mặc định in-memory, dùng chung trong một factory call;
`createRouterLocalV115Tools(state)` cho phép host truyền state riêng.

## Kiểm chứng

```sh
npm run build --workspace=@open-bot/core
npm run build --workspace=@open-bot/tools
npm run typecheck --workspace=@open-bot/core
npm run typecheck --workspace=@open-bot/tools
node --test tests/router-local-v115.test.mjs \
  tests/router-local-v115-registry.test.mjs \
  tests/router-local-v115-tools.test.mjs \
  tests/router-local-v115-i18n.test.mjs
```

51 test xanh (28 catalogue/LRU/policy/budget + 12 registry/gateway/
mock + 8 tools + 3 i18n).

## Giới hạn còn tồn tại

- Chưa test với Ollama/llama-server thật (không có trên máy này);
  chỉ mock server + unit test. Cần Huy/CI có Ollama thật để kiểm
  chứng load/pull/health end-to-end.
- `llama-server` spawn giả định binary có trong PATH và file GGUF
  nằm ở `<ggufDir>/<modelId>.gguf`; chưa có download GGUF thật
  (cố ý — license validate trước, download do host/UI đảm nhiệm).
- Cloud chat thật chưa nối trong gateway (cần host inject `cloudChat`
  từ provider layer); hiện tại route cloud không có `cloudChat` sẽ
  báo lỗi rõ ràng.
- `tests/i18n-v106.test.mjs` pin tổng số key/locale (5278) — sau khi
  thêm 26 key/routerLocal (5304) test đó sẽ đỏ cho tới khi coordinator
  cập nhật pin lúc gộp (đúng quy ước v114).
- TTS/voice, OS popup, VM guest agent không thuộc phạm vi sóng này.
