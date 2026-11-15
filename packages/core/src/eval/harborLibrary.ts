/**
 * Thư viện task Harbor mẫu đi kèm (v1.11, Đội T2).
 *
 * 4 task mẫu THẬT, chạy được local trong sandbox, không cần model
 * ngoài, không cần mạng:
 *
 *  - `hello-file` (general): tạo file greeting.txt với đúng nội dung.
 *  - `sum-csv` (coding): đọc data/numbers.csv, tính tổng, ghi result.txt.
 *  - `fix-add` (coding): sửa hàm add() trong calc.py đang trừ thay vì cộng.
 *  - `markdown-table` (writing): tạo report.md có bảng Markdown đúng định dạng.
 *
 * Mỗi task được định nghĩa bằng code (instruction + environment +
 * test.sh) để UI/tool liệt kê được mà không cần đọc đĩa; hàm
 * `materializeBuiltinHarborTasks(dir)` ghi chúng ra thư mục Harbor
 * chuẩn để runner/load lại qua `loadHarborTaskFromDir` (round-trip
 * được kiểm chứng bằng test).
 *
 * test.sh của các task mẫu chỉ dùng lệnh POSIX cơ bản (sh, grep,
 * test, python3 khi có) và in `PASS <tên>` / `FAIL <tên>` theo đúng
 * hợp đồng của harborTask.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeHarborTaskToDir, type HarborTask } from './harborTask';

/** Id của mọi task mẫu (ổn định — test + UI dựa vào chúng). */
export const BUILTIN_HARBOR_TASK_IDS = ['hello-file', 'sum-csv', 'fix-add', 'markdown-table'] as const;
export type BuiltinHarborTaskId = (typeof BUILTIN_HARBOR_TASK_IDS)[number];

function helloFileTask(): HarborTask {
  return {
    meta: {
      id: 'hello-file',
      name: 'Hello file',
      kind: 'general',
      description: 'Tạo file greeting.txt với đúng nội dung chào mừng.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'file-exists': 1, 'exact-content': 2 },
      tags: ['file-io', 'beginner'],
    },
    instruction: [
      '# Hello file',
      '',
      'Trong thư mục làm việc hiện tại, hãy tạo file `greeting.txt`',
      'với đúng nội dung sau (một dòng, kết thúc bằng ký tự xuống dòng):',
      '',
      '```',
      'Hello, open-bot!',
      '```',
      '',
      'Không tạo thêm file nào khác. Không cần cài đặt gì thêm.',
      '',
    ].join('\n'),
    environment: [],
    testScript: [
      '#!/bin/sh',
      '# Chấm task hello-file: file tồn tại + đúng nội dung.',
      'if [ -f greeting.txt ]; then echo "PASS file-exists"; else echo "FAIL file-exists"; fi',
      'if [ -f greeting.txt ] && [ "$(cat greeting.txt)" = "Hello, open-bot!" ]; then echo "PASS exact-content"; else echo "FAIL exact-content"; fi',
      '',
    ].join('\n'),
  };
}

function sumCsvTask(): HarborTask {
  return {
    meta: {
      id: 'sum-csv',
      name: 'Sum CSV',
      kind: 'coding',
      description: 'Cộng các số trong data/numbers.csv và ghi tổng vào result.txt.',
      version: 1,
      timeoutMs: 120_000,
      maxTurns: 15,
      testWeights: { 'result-exists': 1, 'correct-sum': 2, 'plain-number': 1 },
      tags: ['python', 'csv', 'coding'],
    },
    instruction: [
      '# Sum CSV',
      '',
      'File `data/numbers.csv` chứa một số nguyên trên mỗi dòng.',
      'Hãy tính tổng của tất cả các số và ghi kết quả vào file `result.txt`',
      'trong thư mục làm việc hiện tại. File `result.txt` chỉ chứa một',
      'số nguyên duy nhất (tổng), không có chữ hay ký tự thừa.',
      '',
      'Bạn có thể dùng bất kỳ ngôn ngữ nào có sẵn (python3, node, awk...).',
      '',
    ].join('\n'),
    environment: [{ relativePath: 'data/numbers.csv', content: '12\n7\n25\n6\n' }],
    testScript: [
      '#!/bin/sh',
      '# Chấm task sum-csv: 12+7+25+6 = 50.',
      'if [ -f result.txt ]; then echo "PASS result-exists"; else echo "FAIL result-exists"; fi',
      'if [ -f result.txt ] && [ "$(cat result.txt | tr -d " \\t\\r\\n")" = "50" ]; then echo "PASS correct-sum"; else echo "FAIL correct-sum"; fi',
      'if [ -f result.txt ] && grep -Eq "^[0-9]+$" result.txt; then echo "PASS plain-number"; else echo "FAIL plain-number"; fi',
      '',
    ].join('\n'),
  };
}

function fixAddTask(): HarborTask {
  return {
    meta: {
      id: 'fix-add',
      name: 'Fix add()',
      kind: 'coding',
      description: 'Sửa hàm add() trong calc.py đang trừ thay vì cộng.',
      version: 1,
      timeoutMs: 120_000,
      maxTurns: 15,
      testWeights: { 'add-positive': 2, 'add-negative': 1, 'add-zero': 1 },
      tags: ['python', 'debugging', 'coding'],
    },
    instruction: [
      '# Fix add()',
      '',
      'File `calc.py` có hàm `add(a, b)` nhưng đang trả về kết quả sai.',
      'Hãy sửa `calc.py` sao cho `add(a, b)` trả về tổng `a + b` với mọi',
      'số nguyên (kể cả số âm và số 0). Không được đổi tên hàm, không',
      'được đổi tên file, không được hard-code kết quả cho từng input.',
      '',
    ].join('\n'),
    environment: [
      {
        relativePath: 'calc.py',
        content: [
          '"""Tiny calculator — hàm add() đang bị lỗi, cần sửa."""',
          '',
          '',
          'def add(a, b):',
          '    # LỖI: đang trừ rồi cộng 1 thay vì cộng (fail cả 3 test).',
          '    return a - b + 1',
          '',
          '',
          'def subtract(a, b):',
          '    return a - b',
          '',
        ].join('\n'),
      },
    ],
    testScript: [
      '#!/bin/sh',
      '# Chấm task fix-add bằng python3 (có sẵn trên hầu hết máy dev).',
      'if ! command -v python3 >/dev/null 2>&1; then echo "FAIL add-positive"; echo "FAIL add-negative"; echo "FAIL add-zero"; exit 1; fi',
      'if [ "$(python3 -c "from calc import add; print(add(2, 3))")" = "5" ]; then echo "PASS add-positive"; else echo "FAIL add-positive"; fi',
      'if [ "$(python3 -c "from calc import add; print(add(-4, 1))")" = "-3" ]; then echo "PASS add-negative"; else echo "FAIL add-negative"; fi',
      'if [ "$(python3 -c "from calc import add; print(add(0, 0))")" = "0" ]; then echo "PASS add-zero"; else echo "FAIL add-zero"; fi',
      '',
    ].join('\n'),
  };
}

function markdownTableTask(): HarborTask {
  return {
    meta: {
      id: 'markdown-table',
      name: 'Markdown table',
      kind: 'writing',
      description: 'Tạo report.md với bảng Markdown liệt kê 3 món và tổng tiền.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'report-exists': 1, 'has-table': 2, 'correct-total': 1 },
      tags: ['writing', 'markdown'],
    },
    instruction: [
      '# Markdown table',
      '',
      'Tạo file `report.md` trong thư mục làm việc hiện tại, gồm:',
      '',
      '1. Một tiêu đề cấp 1 (`# ...`) bất kỳ.',
      '2. Một bảng Markdown có đúng 3 hàng dữ liệu cho 3 món sau:',
      '',
      '   | Món   | Giá |',
      '   |-------|-----|',
      '   | Bánh mì | 15000 |',
      '   | Cà phê  | 20000 |',
      '   | Trà sữa | 30000 |',
      '',
      '3. Một dòng ghi tổng tiền `65000` ở bất kỳ đâu trong file.',
      '',
      'Tên cột có thể viết hoa/thường khác đi, nhưng tên món và giá',
      'phải khớp chính xác như trên.',
      '',
    ].join('\n'),
    environment: [],
    testScript: [
      '#!/bin/sh',
      '# Chấm task markdown-table.',
      'if [ -f report.md ]; then echo "PASS report-exists"; else echo "FAIL report-exists"; fi',
      'if [ -f report.md ] && grep -q "Bánh mì" report.md && grep -q "Cà phê" report.md && grep -q "Trà sữa" report.md && grep -q "^|.*|.*|$" report.md; then echo "PASS has-table"; else echo "FAIL has-table"; fi',
      'if [ -f report.md ] && grep -q "65000" report.md; then echo "PASS correct-total"; else echo "FAIL correct-total"; fi',
      '',
    ].join('\n'),
  };
}

/** Toàn bộ task mẫu, theo thứ tự ổn định. */
export function builtinHarborTasks(): HarborTask[] {
  return [helloFileTask(), sumCsvTask(), fixAddTask(), markdownTableTask()];
}

/** Lấy một task mẫu theo id (undefined khi không có). */
export function getBuiltinHarborTask(id: string): HarborTask | undefined {
  return builtinHarborTasks().find((t) => t.meta.id === id);
}

/** Thư mục con chuẩn cho task mẫu dưới một thư mục gốc. */
export function builtinHarborTaskDir(baseDir: string, taskId: string): string {
  return path.join(baseDir, taskId);
}

/**
 * Ghi toàn bộ task mẫu ra `<baseDir>/<taskId>/` theo đúng định dạng
 * Harbor (task.json + instruction.md + environment/ + tests/test.sh).
 * Trả về danh sách thư mục đã ghi. Ghi đè task mẫu cũ cùng id.
 */
export function materializeBuiltinHarborTasks(baseDir: string): string[] {
  fs.mkdirSync(baseDir, { recursive: true });
  const dirs: string[] = [];
  for (const task of builtinHarborTasks()) {
    dirs.push(writeHarborTaskToDir(task, builtinHarborTaskDir(baseDir, task.meta.id)));
  }
  return dirs;
}

/** Thư mục mặc định chứa task mẫu trong userData (`<userData>/harbor-tasks`). */
export function defaultHarborTasksDir(userDataDir: string): string {
  return path.join(userDataDir, 'harbor-tasks');
}
