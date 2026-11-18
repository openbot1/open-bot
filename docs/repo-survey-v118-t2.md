# Repo survey — sóng v1.18, Đội T2 (16/11/2026)

Nghiên cứu nhanh trước sóng v1.18. CHỈ HỌC Ý TƯỞNG — không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.

Nguồn chính: datacamp.com/tutorial/openhands, dev.to/lynkr/run-openhands-on-any-model-you-want-1mnd (theo brief sóng).

## 1. OpenHands V1 SDK — event-sourced ConversationState + CodeAct

- **Event-sourced ConversationState:** mọi bước của agent là event bất biến (Action của agent / Observation của môi trường) trong một event log append-only; trạng thái phiên được suy ra bằng fold từ log. Nhờ đó: replay toàn bộ phiên từ log, snapshot + resume đúng chỗ, fork phiên tại bất kỳ event nào (time-travel debugging), audit trail đầy đủ. Đây là pattern chuẩn của OpenHands V1 SDK.
- **CodeAct agent:** agent không gọi tool rời rạc cho từng thao tác file/shell — agent viết code (bash/python) rồi chạy trong sandbox, đọc stdout/stderr/exit code rồi lặp. Một tool chạy code duy nhất thay cho chục tool nhỏ; agent tự quyết định dùng code để làm gì (đọc file, sửa file, chạy test, grep...). Yêu cầu: sandbox thật (microVM/Docker), timeout + giới hạn tài nguyên, allowlist/denylist lệnh.
- **Sandbox/microVM execution:** mọi code chạy trong môi trường cô lập, không chạm host; giới hạn CPU/RAM/thời gian/output; file tạm dọn sau khi chạy.
- **Vòng lặp plan → edit → run test → lặp:** agent lập kế hoạch, edit, chạy test trong sandbox, đọc lỗi, sửa lại, tối đa N vòng; commit + mở draft PR khi xanh. OpenHands đạt ~72% SWE-Bench Verified với frontier model (con số này là của OpenHands với model mạnh + Docker, không phải của open-bot — open-bot chỉ học pattern, đo bằng harness nội bộ của mình).
- **Repository Map:** tóm tắt repo (symbol + import + call graph) nén xuống vài nghìn token để nhét vào context; PageRank trên graph import/call để xếp hạng file/symbol liên quan nhất tới task.

**Áp vào v1.18 (T2 coding agent v10):** event-sourced session riêng cho phiên coding (khác run log ở `event-log/` — log theo run của AgentRunner): Action/Observation bất biến, hash chain SHA-256, snapshot + replay toàn bộ phiên, fork tại bất kỳ event nào (tính lại hash chain cho phiên con), pause/resume có persist xuống đĩa; CodeAct executor node/python/bash chạy bằng argv (không shell), denylist codeact + denylist/allowlist v9, timeout + cap output, kết quả thành Observation event; repo map v10 = hierarchical summaries module → file → symbol trên nền PageRank v3 của v8, nén theo ngân sách token, incremental theo content hash, query theo symbol, cache summary persist xuống đĩa.

## 2. Aider — git-first + repo map tree-sitter + Architect–Editor

- **Git-first atomic commit:** mỗi edit thành công = 1 commit atomic + message tự sinh từ diff; có thể rollback từng commit; draft-PR description sinh từ lịch sử commit. Aider làm vậy để mọi thay đổi đều revert được và review được.
- **Repo map tree-sitter:** parse bằng tree-sitter (không regex), lấy signature class/function + import, không lấy thân hàm — nén cả repo lớn xuống vài nghìn token; cập nhật tăng dần khi file đổi.
- **Architect–Editor pattern:** 2 model — planner mạnh lập kế hoạch (architect), editor rẻ thực thi (editor); tách bạch để tiết kiệm token/cost mà vẫn giữ chất lượng plan.
- **Edit strategies:** search-and-replace block là mặc định (ít token hơn whole-file); whole-file chỉ khi file viết lại gần hết; AST-aware edit (thay đúng symbol theo vị trí AST) là chính xác nhất nhưng cần parser tốt.

**Áp vào v1.18 (T2 coding agent v10):** nối git atomic của v9 (không viết lại) — mỗi edit v10 có thể commit atomic ngay; strategy selector chấm điểm 3 chiến lược (AST 100 > search-replace 80 > whole-file 40, trừ điểm theo số dòng đổi), preview cả 3 trước khi áp, fallback có ghi rõ, verify parse lại bằng parser v8 + khôi phục file khi verify fail; repo map v10 dùng parser v8 (tree-sitter-lite) thay vì parse lại.

## 3. Eval — SWE-bench-style, đo theo phiên bản agent

- SWE-bench: task mẫu (repo nhỏ + test FAIL_TO_PASS / PASS_TO_PASS), chạy agent, đo pass@k. Điểm mới của v10 so với v9: lưu kết quả THEO PHIÊN BẢN agent (mỗi version một thư mục) để so sánh các version với nhau, thay vì chỉ so sánh hai lần chạy. Scripted agent mẫu sửa đúng 5/6 task (cố tình sai 1 để demo pass@k < 100%).
- Lưu ý trung thực: pass@k nội bộ trên 6 task mẫu nhỏ không tương đương SWE-Bench Verified; chỉ dùng để so sánh các version của chính open-bot với nhau.

## 4. Giới hạn còn lại (nói rõ, không giấu)

- CodeAct v10 chạy bằng `spawn` argv trong working dir local, KHÔNG phải microVM/Docker thật: cô lập yếu hơn OpenHands (chỉ có timeout + cap output + allowlist/denylist; CPU/RAM chỉ enforce thêm khi chạy trong BotBox). Không chạy code không tin cậy.
- Repo map v10 resolve call theo tên ngắn (kế thừa v8): method trùng tên ở nhiều class có thể nối nhầm cạnh; PageRank incremental là xấp xỉ.
- Resume sau pause: plan provider của host phải idempotent — event log ghi lại cả lần chạy lại, không tự dedupe edit đã áp.
- Agent v10 không gọi model thật: plan/fix đều do host tiêm provider; chất lượng phụ thuộc provider đó.
