# Repo survey v1.30 — 2026-11-17

Nghiên cứu phục vụ sóng v1.30. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

## 1. Temporal 1.32.x — durable execution (temporalio/temporal, MIT, Go)

- Agent = Workflow bền: mọi bước ghi vào append-only event history; crash/deploy xong worker
  mới replay history để khôi phục đúng state và chạy tiếp từ dòng bị gián đoạn — không chạy lại
  từ đầu, không checkpoint thủ công. Hoạt động có side-effect (gọi model, tool, gửi mail) là
  Activity, được retry tự động khi lỗi thoáng qua (rate limit, timeout, provider down).
- **Signals + Queries + Updates**: workflow đang chạy nhận tín hiệu từ bên ngoài (phê duyệt,
  hủy, bổ sung dữ kiện) mà không cần restart; `wait_condition` chờ phê duyệt hàng giờ/ngày
  vẫn sống qua restart worker. Đây là mẫu approval chuẩn cho agent có hành động hệ quả.
- **Continue-As-New**: một execution giới hạn ~51.200 event / 50 MB history; vòng lặp dài phải
  tự khởi động lại thành execution mới mang theo state tóm tắt — bài học trực tiếp cho agent
  chạy nhiều ngày.
- Determinism bắt buộc: code workflow không được gọi trực tiếp mạng/đồng hồ/random ngoài SDK —
  mọi thứ không xác định phải qua Activity. Test có time-skipping test environment.
- **Temporal Agent Harness** (08/2026, Apache 2.0, còn rất sớm): bọc agent SDK sẵn có
  (OpenAI Agents SDK, Google ADK, Strands) thành Temporal Workflow — durable execution,
  approval policy, typed operation, event stream có cấu trúc. Tích hợp Gemini + OpenAI trước.
- v1.32.2 (02/11/2026): Standalone Activities GA, Activity eager execution mặc định, Nexus
  Operations pre-release. Server tự host miễn phí (MIT, không open-core); Cloud trả theo action.
- **Đem vào open-bot**: T1 memory v-next — run history kiểu event-sourced cho agent run:
  append-only log từng bước (model call, tool call, signal), resume sau crash/restart, prune +
  Continue-As-New cho run dài; T6 platform/fleet v-next — automation bền: lịch bot chạy nền
  là durable workflow có retry, signal phê duyệt, chờ nhiều ngày vẫn sống qua restart.

## 2. OpenTelemetry GenAI observability — trace là dữ liệu eval (chuẩn mở, 2026)

- Chuẩn đang hội tụ: OTel GenAI semantic conventions — span `invoke_agent` (một run),
  `plan` (suy luận/phân rã), `execute_tool` (một tool call), `chat` (model call), kèm
  `gen_ai.*` attributes (model, token usage input/output, latency, error.type). Client spans
  GenAI ra khỏi experimental đầu 2026; attribute vẫn ở mức Development nên phải pin version
  và giữ bảng "tested with" có ngày.
- **Trace là bằng chứng, không phải đánh giá**: trace ghi agent đã làm gì; eval mới trả lời
  "làm vậy có đúng không" — chọn đúng tool ở mỗi bước? có dừng đúng lúc? output có khớp
  retrieval? Kiến trúc đúng = trace trajectory trước, rồi chạy eval trên trajectory.
- **Trace dùng lại làm dataset eval**: DeepEval v4.0.3 và Arize Phoenix v16 (21/05/2026) đều
  đọc trực tiếp OTel trace — span đã emit nhân đôi thành eval dataset, không cần lớp
  instrumentation thứ hai. Mẫu thực tế: job nightly lấy ~50 trace `invoke_agent` trong ngày,
  reconstruct từng run (input → tool sequence → output), chấm faithfulness + rule riêng.
- Local-first hoàn toàn khả thi: Strands Agents + Ollama + OTel, backend Jaeger v2 (nhận OTLP
  trực tiếp 4317/4318) hoặc Grafana Tempo trong một container — không cần API key, không cần
  cloud. Overhead <1ms/span so với latency LLM 100ms–30s. Chỉ ~15% deployment GenAI có
  instrument observability (Gartner, theo một guide 2026) — đây là khoảng trống thật.
- **Đem vào open-bot**: T2 protocols v-next — instrumentation OTel GenAI cho toàn bộ agent
  loop: root span `invoke_agent`, con `chat`/`execute_tool`/`plan`, export OTLP + file local,
  token/cost metrics, sampling; T4 coding agent v-next — eval harness trên trajectory:
  eval case chạy trong span riêng tag `eval.case_id`/`eval.passed`, trace fail truy vấn được
  ngay (tool nào bị skip, retrieval nói gì), LLM-judge chấm điểm, cổng chất lượng CI.

## 3. Local inference broker — llama.cpp / vLLM / SGLang (2026)

- Bốn engine, bốn vai trò khác nhau, tất cả đều expose API OpenAI-compatible nên đổi backend
  chỉ là đổi URL: **Ollama** dễ nhất, ~41 TPS, lazy-load/unload theo `keep_alive`, outgrow ở
  ~5 user đồng thời; **llama.cpp** (`llama-server`) linh hoạt nhất — GGUF 2–8 bit, offload
  từng layer, split layer/row/tensor, chạy CPU/GPU/Metal/Vulkan, slot song song + continuous
  batching cho vài user; **vLLM** throughput cao nhất (~793 TPS peak), PagedAttention +
  continuous batching, tensor/pipeline parallelism, sleep-mode endpoint giải phóng VRAM
  không cần restart, phục vụ 10+ user; **SGLang** tốt nhất cho agent pipeline nhiều lượt —
  RadixAttention tái dùng prefix chung, disaggregated prefill/decode, constrained decoding
  nhanh (xGrammar) cho structured output.
- **Broker mới là lớp quan trọng, không phải backend**: broker sở hữu vòng đời process
  (spawn/stop theo nhu cầu, trừ Ollama tự quản), readiness gate (`/health` llama.cpp trả
  503 khi đang load — chỉ check khi process đang chạy), idle-freeing, chọn engine theo GPU
  và workload (đồng thời thấp → llama.cpp, đồng thời cao → vLLM, pipeline nhiều lượt chia
  sẻ context → SGLang).
- Quantization: Q4_K_M là default thực tế (8B → ~5GB, vừa GPU 8GB); AWQ/GPTQ/FP8 chỉ trên
  Safetensors (vLLM/SGLang), GGUF trên vLLM vẫn là plugin thử nghiệm. Số TPS công bố chỉ
  mang tính định hướng — quantization + context length làm lệch lớn.
- **Đem vào open-bot**: T3 local-model router v-next — inference broker: lifecycle
  Ollama/llama-server/vLLM/SGLang (spawn, health gate, idle unload, sleep-mode), ma trận
  capability từng engine, routing prefix-cache-aware (chọn engine giữ KV cache của phiên),
  structured-output qua grammar/JSON schema, fallback chuỗi khi engine lỗi.

## 4. Ghi chú sóng v1.30

- v1.29 đang chạy (coordinator lần 5, merge/v129): T2 protocols v6 + T3 coding v14 đã gộp;
  T1/T4/T5/T6 chưa thấy commit gộp — coordinator v1.30 PHẢI đọc merge/v129 HEAD bằng grep
  để lấy đúng số version hiện tại của từng subsystem rồi mới đặt số mới, tránh va chạm
  kiểu v1.27/v1.28 (cùng protocolsV5, cùng voiceV19).
- Main vẫn ở v1.20 (ec4bf689, suite ĐỎ lúc land) — các sóng v1.21–v1.29 đang xếp chồng trên
  nhánh merge/v12X, chưa land main, remote GitHub vẫn v1.17 (2/11). Sóng v1.30 KHÔNG tự
  fast-forward main, KHÔNG đẩy GitHub — chỉ gộp + kiểm chứng xanh trên merge/v130 rồi báo cáo.
