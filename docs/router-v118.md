# Router local v118 (v1.41, Đội T3)

Programmatic tool calling + `tool_choice` theo provider mới + inline-tools.
Ý tưởng từ survey `docs/repo-survey-v141.md` §1 (cạm bẫy provider 2026);
chỉ học ý tưởng, không copy code/text/tài sản của bất kỳ repo nào.

## 1. Programmatic tool calling — `packages/core/src/router/local/programmaticToolCallingV118.ts`

Agent viết script gọi nhiều tool trong sandbox, chỉ kết quả cuối vào context.

- DSL riêng (parser recursive-descent viết tay, **không `eval`/`Function`**):
  `let`/`const`, gán, `return`, `if/else`, `for...of`, `while`, ternary,
  array/object literal, member/index access, số/chuỗi/bool/null.
- API duy nhất trong script: `call("tool", {args})`, `log(...)`, biến
  chỉ-đọc `input`, mảng `results` (kết quả các call trước).
- An toàn: quét tĩnh cấm `require/process/fetch/eval/Function/__proto__/
  constructor/...`; interpreter không có primitive fs/network; chặn truy
  cập `__proto__`/`constructor`/`prototype` cả lúc chạy.
- Giới hạn: step budget (mặc định 10.000), max call (32), wall-clock
  (5.000 ms, kiểm tra mỗi 64 bước), cắt kết quả (20.000 ký tự).
- Audit: mỗi tool call ghi seq/tool/args/duration/ok/error/preview
  (`ScriptAuditStore`, tối đa 200 entry).
- Lỗi → fallback: `fallbackToNormalToolCalls: true`, giữ các call đã
  xong, gợi ý gọi lại tool lỗi bằng tool call thường.
- Executor do host đăng ký (`registerRouterLocalV118Executor`); mặc
  định không có executor → script fail-closed.

## 2. tool_choice theo provider — `toolChoiceV118.ts`

Ma trận capability 10 provider (anthropic/openai/gemini/xai/deepseek/
ollama/llamacpp/vllm/sglang/openai-compatible) + override theo model.

- Claude lớn (Opus/Sonnet 5.x, Fable, Mythos): chỉ `auto`/`none` —
  `any`/`tool` trả 400 → ép xuống `auto` kèm lý do.
- Ollama: không hỗ trợ `tool_choice` → mọi chế độ ép về `auto`;
  `none` được thực thi bằng cách **không gửi `tools`**.
- Gemini: `tool` → `any` (ép tool cụ thể bằng `allowed_function_names`).
- DeepSeek: `any` → `auto`. Provider chưa biết: fail-closed
  (`auto`/`none`, không parallel, max 32 tool).
- `buildProviderRequestParams`: loại `temperature`/`top_p`/`top_k` khi
  API version ≥ `2026-10-21` (kể cả giá trị mặc định); beta
  `inline-tools-2026-09-15` chỉ gửi khi provider hỗ trợ.

## 3. Inline tools — `inlineToolsV118.ts`

Đổi tool giữa hội thoại không phá prompt cache.

- Tool set versioning (v1, +1 khi đổi thật; no-op giữ version), hash
  ổn định FNV-1a + JSON canonical (sort key đệ quy).
- Cache key tách đôi: `prefixKey` (system + history + model) và
  `toolKey` (version + hash tool set). Đổi tool chỉ đổi `toolKey` —
  `prefixCacheSurvivesToolChange` chứng minh điều đó.
- Server-side thread: `lockThreadToolSet` khóa fingerprint; `checkThreadToolSet`
  báo `wouldMismatch` trước khi gửi để tránh `thread_fingerprint_mismatch`.

## 4. Mở rộng (cùng sóng)

- `botPolicyV118.ts`: policy theo bot (allow/deny tool + provider,
  allowScript, max tool/cost) — merge theo quy tắc chặt nhất (deny thắng,
  allow giao nhau, giới hạn lấy min).
- `costAwareRoutingV118.ts`: chọn model rẻ nhất đạt ngưỡng chất lượng
  theo độ khó; ledger + báo cáo tiết kiệm so với model mạnh nhất.
- `retryBackoffV118.ts`: phân loại lỗi + lịch retry (429/5xx/timeout →
  backoff mũ + jitter có seed; 400 tool_choice → hạ cấp auto 1 lần;
  400 sampling → loại param 1 lần; fingerprint → thread mới 1 lần;
  401/403/404 không retry) + cooldown circuit-breaker (5 lỗi liên tiếp).

## 5. Tools + i18n + test

- 15 tool `router_local_v118_*` trong `packages/tools/src/routerLocalV118Tools.ts`,
  đăng ký trong `ALL_TOOLS` (`tools.ts`, pattern replace-in-place như v117).
- i18n: 40 key `router.v118.*` × 6 locale (en/es/fr/ja/vi/zh).
- Test: `tests/router-v118-{tool-choice,inline-tools,script,policy-cost-retry,tools,i18n}.test.mjs`
  (node:test, import core/tools đã build).
