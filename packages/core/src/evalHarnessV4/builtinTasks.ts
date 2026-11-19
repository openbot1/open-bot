/**
 * Task Harbor mẫu của Eval Harness v4 (v1.44, Đội T2).
 *
 * 4 task mẫu MỚI, khác hẳn 4 task v1.11 (`hello-file`, `sum-csv`,
 * `fix-add`, `markdown-table`) — V4 cần thêm task để đo các kỹ
 * năng chưa có trong bộ mẫu cũ:
 *
 *  - `json-transform` (coding): đọc JSON, biến đổi trường, ghi JSON mới.
 *  - `sort-lines` (general): sắp xếp + khử trùng lặp các dòng text.
 *  - `fix-import` (coding): sửa import Python hỏng (`maths` → `math`).
 *  - `readme-headings` (writing): tạo README.md đủ các heading yêu cầu.
 *  - `word-count` (general): đếm dòng/từ/ký tự, ghi counts.json.
 *  - `log-grep` (general): lọc dòng ERROR trong log, ghi errors.txt.
 *  - `config-fix` (coding): sửa file JSON hỏng (dấu phẩy thừa),
 *    ghi fixed.json hợp lệ với cùng giá trị.
 *  - `changelog-entry` (writing): thêm mục release mới vào
 *    CHANGELOG.md, giữ nguyên các mục cũ.
 *
 * Mỗi task tuân thủ đúng định dạng Harbor (xem `eval/harborTask.ts`):
 * instruction.md + environment/ + tests/test.sh, test.sh chỉ dùng
 * lệnh POSIX cơ bản (sh, grep, test, sort, python3 khi có) và in
 * `PASS <tên>` / `FAIL <tên>`. Khi python3 vắng mặt, test.sh in
 * FAIL rõ ràng thay vì pass giả — giống phong cách của `fix-add`.
 *
 * Task được định nghĩa bằng code để UI/CLI liệt kê được mà không
 * cần đọc đĩa; `materializeBuiltinEvalHarnessV4Tasks(dir)` ghi
 * chúng ra thư mục Harbor chuẩn để load lại qua
 * `loadHarborTaskFromDir` (round-trip được kiểm chứng bằng test).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeHarborTaskToDir, type HarborTask } from '../eval/harborTask';

/** Id của mọi task mẫu V4 (ổn định — test + UI dựa vào chúng). */
export const BUILTIN_EVAL_HARNESS_V4_TASK_IDS = [
  'json-transform',
  'sort-lines',
  'fix-import',
  'readme-headings',
  'word-count',
  'log-grep',
  'config-fix',
  'changelog-entry',
] as const;
export type BuiltinEvalHarnessV4TaskId = (typeof BUILTIN_EVAL_HARNESS_V4_TASK_IDS)[number];

function jsonTransformTask(): HarborTask {
  return {
    meta: {
      id: 'json-transform',
      name: 'JSON transform',
      kind: 'coding',
      description: 'Đọc data/input.json, biến đổi trường, ghi output.json.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'file-exists': 1, 'name-upper': 2, 'total-correct': 2, 'passed-flag': 1 },
      tags: ['json', 'data', 'coding'],
    },
    instruction: [
      '# JSON transform',
      '',
      'File `data/input.json` chứa một object:',
      '',
      '```json',
      '{ "name": "Ada", "age": 36, "scores": [8, 9, 7] }',
      '```',
      '',
      'Hãy tạo file `output.json` trong thư mục làm việc với đúng nội dung sau:',
      '',
      '- `name`: tên viết hoa toàn bộ (`"ADA"`).',
      '- `age`: giữ nguyên (`36`).',
      '- `total`: tổng của `scores` (`24`).',
      '- `passed`: `true` khi `total >= 20`, ngược lại `false`.',
      '',
      'Định dạng JSON không quan trọng (khoảng trắng, thứ tự key tự do),',
      'miễn là các giá trị đúng. Bạn có thể dùng bất kỳ ngôn ngữ nào có',
      'sẵn (python3, node, jq...). Không sửa `data/input.json`.',
      '',
    ].join('\n'),
    environment: [
      {
        relativePath: 'data/input.json',
        content: '{\n  "name": "Ada",\n  "age": 36,\n  "scores": [8, 9, 7]\n}\n',
      },
    ],
    testScript: [
      '#!/bin/sh',
      '# Chấm task json-transform: file tồn tại + các trường đúng giá trị.',
      '# Dùng python3 để parse JSON thật (không grep chuỗi thô).',
      'if [ ! -f output.json ]; then echo "FAIL file-exists"; echo "FAIL name-upper"; echo "FAIL total-correct"; echo "FAIL passed-flag"; exit 1; fi',
      'echo "PASS file-exists"',
      'if ! command -v python3 >/dev/null 2>&1; then echo "FAIL name-upper"; echo "FAIL total-correct"; echo "FAIL passed-flag"; exit 1; fi',
      'if [ "$(python3 -c "import json; print(json.load(open(\'output.json\'))[\'name\'])")" = "ADA" ]; then echo "PASS name-upper"; else echo "FAIL name-upper"; fi',
      'if [ "$(python3 -c "import json; print(json.load(open(\'output.json\'))[\'total\'])")" = "24" ]; then echo "PASS total-correct"; else echo "FAIL total-correct"; fi',
      'if [ "$(python3 -c "import json; print(json.load(open(\'output.json\'))[\'passed\'])")" = "True" ]; then echo "PASS passed-flag"; else echo "FAIL passed-flag"; fi',
      '',
    ].join('\n'),
  };
}

function sortLinesTask(): HarborTask {
  return {
    meta: {
      id: 'sort-lines',
      name: 'Sort lines',
      kind: 'general',
      description: 'Sắp xếp tên trong names.txt, khử trùng lặp, ghi sorted.txt.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'file-exists': 1, 'sorted-order': 2, 'deduped': 2, 'same-content': 1 },
      tags: ['text', 'shell', 'file-io'],
    },
    instruction: [
      '# Sort lines',
      '',
      'File `names.txt` chứa các tên, chưa sắp xếp và có dòng trùng lặp.',
      'Hãy tạo file `sorted.txt` với các yêu cầu sau:',
      '',
      '- Mọi tên trong `names.txt` đều xuất hiện, mỗi tên đúng một lần.',
      '- Các dòng được sắp xếp theo thứ tự bảng chữ cái (a → z).',
      '- Không thêm tên mới, không bỏ tên nào, không sửa chính tả.',
      '',
      'Bạn có thể dùng `sort`/`uniq` hoặc bất kỳ công cụ nào có sẵn.',
      'Không sửa `names.txt`.',
      '',
    ].join('\n'),
    environment: [
      {
        relativePath: 'names.txt',
        content: 'Minh\nAn\nLan\nMinh\nHoa\nAn\nTuan\nLan\n',
      },
    ],
    testScript: [
      '#!/bin/sh',
      '# Chấm task sort-lines: file tồn tại + đã sort + khử trùng + đủ nội dung.',
      'if [ ! -f sorted.txt ]; then echo "FAIL file-exists"; echo "FAIL sorted-order"; echo "FAIL deduped"; echo "FAIL same-content"; exit 1; fi',
      'echo "PASS file-exists"',
      'if sort -c sorted.txt 2>/dev/null; then echo "PASS sorted-order"; else echo "FAIL sorted-order"; fi',
      'if [ -z "$(sort sorted.txt | uniq -d)" ]; then echo "PASS deduped"; else echo "FAIL deduped"; fi',
      'if [ "$(sort names.txt | uniq)" = "$(cat sorted.txt)" ]; then echo "PASS same-content"; else echo "FAIL same-content"; fi',
      '',
    ].join('\n'),
  };
}

function fixImportTask(): HarborTask {
  return {
    meta: {
      id: 'fix-import',
      name: 'Fix import',
      kind: 'coding',
      description: 'Sửa import Python hỏng trong app.py (maths → math).',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'runs-ok': 2, 'uses-math': 1, 'no-maths': 1 },
      tags: ['python', 'debugging', 'coding'],
    },
    instruction: [
      '# Fix import',
      '',
      'File `app.py` bị lỗi import nên không chạy được:',
      '',
      '```python',
      'import maths',
      '',
      'print(maths.sqrt(16))',
      '```',
      '',
      'Hãy sửa `app.py` sao cho chạy được bằng `python3 app.py` và in ra',
      '`4.0`. Chỉ sửa phần import/call bị hỏng — không được hard-code',
      'kết quả bằng `print(4.0)`, không được đổi tên file.',
      '',
    ].join('\n'),
    environment: [
      {
        relativePath: 'app.py',
        content: 'import maths\n\nprint(maths.sqrt(16))\n',
      },
    ],
    testScript: [
      '#!/bin/sh',
      '# Chấm task fix-import bằng python3 (có sẵn trên hầu hết máy dev).',
      'if ! command -v python3 >/dev/null 2>&1; then echo "FAIL runs-ok"; echo "FAIL uses-math"; echo "FAIL no-maths"; exit 1; fi',
      'if [ "$(python3 app.py 2>/dev/null)" = "4.0" ]; then echo "PASS runs-ok"; else echo "FAIL runs-ok"; fi',
      'if grep -qx "import math" app.py; then echo "PASS uses-math"; else echo "FAIL uses-math"; fi',
      'if grep -q "maths" app.py; then echo "FAIL no-maths"; else echo "PASS no-maths"; fi',
      '',
    ].join('\n'),
  };
}

function readmeHeadingsTask(): HarborTask {
  return {
    meta: {
      id: 'readme-headings',
      name: 'README headings',
      kind: 'writing',
      description: 'Tạo README.md có đủ 3 heading yêu cầu + nội dung mô tả.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'file-exists': 1, 'has-title': 1, 'has-install': 1, 'has-usage': 1, 'has-description': 1 },
      tags: ['markdown', 'writing', 'docs'],
    },
    instruction: [
      '# README headings',
      '',
      'Hãy tạo file `README.md` mô tả một công cụ dòng lệnh tên `notecli`',
      '(ghi chú nhanh từ terminal). README phải có:',
      '',
      '- Heading cấp 1 `# notecli` (tiêu đề).',
      '- Heading cấp 2 `## Install` (hướng dẫn cài đặt, ít nhất 1 dòng).',
      '- Heading cấp 2 `## Usage` (hướng dẫn dùng, ít nhất 1 dòng).',
      '- Ít nhất một đoạn mô tả công cụ làm gì (ít nhất 20 ký tự,',
      '  không tính heading).',
      '',
      'Nội dung cụ thể do bạn viết — miễn là đủ các phần trên và mô tả',
      'khớp với công cụ ghi chú (không viết về chủ đề khác).',
      '',
    ].join('\n'),
    environment: [],
    testScript: [
      '#!/bin/sh',
      '# Chấm task readme-headings: file tồn tại + đủ heading + có mô tả.',
      'if [ ! -f README.md ]; then echo "FAIL file-exists"; echo "FAIL has-title"; echo "FAIL has-install"; echo "FAIL has-usage"; echo "FAIL has-description"; exit 1; fi',
      'echo "PASS file-exists"',
      'if grep -qx "# notecli" README.md; then echo "PASS has-title"; else echo "FAIL has-title"; fi',
      'if grep -qx "## Install" README.md; then echo "PASS has-install"; else echo "FAIL has-install"; fi',
      'if grep -qx "## Usage" README.md; then echo "PASS has-usage"; else echo "FAIL has-usage"; fi',
      'if [ "$(grep -v "^#" README.md | tr -d " \\t\\n" | wc -c)" -ge 20 ]; then echo "PASS has-description"; else echo "FAIL has-description"; fi',
      '',
    ].join('\n'),
  };
}

function wordCountTask(): HarborTask {
  return {
    meta: {
      id: 'word-count',
      name: 'Word count',
      kind: 'general',
      description: 'Đếm dòng/từ/ký tự trong notes.txt, ghi counts.json.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'file-exists': 1, 'lines-correct': 1, 'words-correct': 2, 'chars-correct': 1 },
      tags: ['text', 'json', 'file-io'],
    },
    instruction: [
      '# Word count',
      '',
      'File `notes.txt` chứa 3 dòng văn bản. Hãy tạo file `counts.json`',
      'với đúng nội dung sau:',
      '',
      '- `lines`: số dòng trong `notes.txt` (3).',
      '- `words`: số từ trong `notes.txt`, từ là các token cách nhau',
      '  bằng khoảng trắng (13).',
      '- `chars`: tổng số ký tự trong `notes.txt`, KHÔNG tính ký tự',
      '  xuống dòng cuối mỗi dòng (64).',
      '',
      'Định dạng JSON không quan trọng, miễn là các giá trị đúng.',
      'Bạn có thể dùng bất kỳ ngôn ngữ nào có sẵn (python3, node,',
      'wc...). Không sửa `notes.txt`.',
      '',
    ].join('\n'),
    environment: [
      {
        relativePath: 'notes.txt',
        content: 'The quick brown fox\njumps over the lazy dog\nOpen bot builds agents\n',
      },
    ],
    testScript: [
      '#!/bin/sh',
      '# Chấm task word-count bằng python3 (parse JSON thật).',
      'if [ ! -f counts.json ]; then echo "FAIL file-exists"; echo "FAIL lines-correct"; echo "FAIL words-correct"; echo "FAIL chars-correct"; exit 1; fi',
      'echo "PASS file-exists"',
      'if ! command -v python3 >/dev/null 2>&1; then echo "FAIL lines-correct"; echo "FAIL words-correct"; echo "FAIL chars-correct"; exit 1; fi',
      'if [ "$(python3 -c "import json; print(json.load(open(\'counts.json\'))[\'lines\'])")" = "3" ]; then echo "PASS lines-correct"; else echo "FAIL lines-correct"; fi',
      'if [ "$(python3 -c "import json; print(json.load(open(\'counts.json\'))[\'words\'])")" = "13" ]; then echo "PASS words-correct"; else echo "FAIL words-correct"; fi',
      'if [ "$(python3 -c "import json; print(json.load(open(\'counts.json\'))[\'chars\'])")" = "64" ]; then echo "PASS chars-correct"; else echo "FAIL chars-correct"; fi',
      '',
    ].join('\n'),
  };
}

function logGrepTask(): HarborTask {
  return {
    meta: {
      id: 'log-grep',
      name: 'Log grep',
      kind: 'general',
      description: 'Lọc các dòng ERROR trong app.log, ghi errors.txt theo thứ tự.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'file-exists': 1, 'exact-content': 3, 'line-count': 1 },
      tags: ['text', 'shell', 'log'],
    },
    instruction: [
      '# Log grep',
      '',
      'File `app.log` chứa các dòng log INFO/WARN/ERROR. Hãy tạo file',
      '`errors.txt` chứa ĐÚNG các dòng có `ERROR` trong `app.log`,',
      'giữ nguyên thứ tự và nội dung từng dòng, không thêm dòng nào',
      'khác, không bỏ dòng ERROR nào.',
      '',
      'Bạn có thể dùng `grep` hoặc bất kỳ công cụ nào có sẵn.',
      'Không sửa `app.log`.',
      '',
    ].join('\n'),
    environment: [
      {
        relativePath: 'app.log',
        content: [
          '2026-11-19T05:00:01 INFO Server started on port 3000',
          '2026-11-19T05:00:02 ERROR Failed to connect to database',
          '2026-11-19T05:00:03 INFO Retrying connection',
          '2026-11-19T05:00:04 ERROR Timeout after 30s',
          '2026-11-19T05:00:05 WARN Memory usage high',
          '2026-11-19T05:00:06 ERROR Disk almost full',
          '',
        ].join('\n'),
      },
    ],
    testScript: [
      '#!/bin/sh',
      '# Chấm task log-grep: file tồn tại + đúng nội dung + đúng số dòng.',
      'if [ ! -f errors.txt ]; then echo "FAIL file-exists"; echo "FAIL exact-content"; echo "FAIL line-count"; exit 1; fi',
      'echo "PASS file-exists"',
      'if [ "$(grep ERROR app.log)" = "$(cat errors.txt)" ]; then echo "PASS exact-content"; else echo "FAIL exact-content"; fi',
      'if [ "$(grep -c ERROR app.log)" = "$(wc -l < errors.txt)" ]; then echo "PASS line-count"; else echo "FAIL line-count"; fi',
      '',
    ].join('\n'),
  };
}

function configFixTask(): HarborTask {
  return {
    meta: {
      id: 'config-fix',
      name: 'Config fix',
      kind: 'coding',
      description: 'Sửa file JSON hỏng trong broken.json, ghi fixed.json hợp lệ.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'file-exists': 1, 'valid-json': 2, 'values-correct': 2 },
      tags: ['json', 'debugging', 'coding'],
    },
    instruction: [
      '# Config fix',
      '',
      'File `broken.json` chứa cấu hình nhưng bị hỏng cú pháp JSON',
      '(dấu phẩy thừa ở cuối) nên `python3 -m json.tool broken.json`',
      'báo lỗi. Hãy tạo file `fixed.json` là JSON HỢP LỆ với đúng',
      'các giá trị sau:',
      '',
      '- `host`: `"localhost"`.',
      '- `port`: `3000`.',
      '- `debug`: `true`.',
      '',
      'Không thêm/bớt/sửa giá trị nào khác. Không sửa `broken.json`.',
      '',
    ].join('\n'),
    environment: [
      {
        relativePath: 'broken.json',
        content: '{\n  "host": "localhost",\n  "port": 3000,\n  "debug": true,\n}\n',
      },
    ],
    testScript: [
      '#!/bin/sh',
      '# Chấm task config-fix bằng python3 (parse JSON thật).',
      'if [ ! -f fixed.json ]; then echo "FAIL file-exists"; echo "FAIL valid-json"; echo "FAIL values-correct"; exit 1; fi',
      'echo "PASS file-exists"',
      'if ! command -v python3 >/dev/null 2>&1; then echo "FAIL valid-json"; echo "FAIL values-correct"; exit 1; fi',
      'if python3 -m json.tool fixed.json >/dev/null 2>&1; then echo "PASS valid-json"; else echo "FAIL valid-json"; exit 1; fi',
      'if [ "$(python3 -c "import json; d = json.load(open(\'fixed.json\')); print(d[\'host\'], d[\'port\'], d[\'debug\'])")" = "localhost 3000 True" ]; then echo "PASS values-correct"; else echo "FAIL values-correct"; fi',
      '',
    ].join('\n'),
  };
}

function changelogEntryTask(): HarborTask {
  return {
    meta: {
      id: 'changelog-entry',
      name: 'Changelog entry',
      kind: 'writing',
      description: 'Thêm mục release 1.1.0 vào CHANGELOG.md, giữ nguyên mục cũ.',
      version: 1,
      timeoutMs: 60_000,
      maxTurns: 10,
      testWeights: { 'has-version': 2, 'has-added': 1, 'has-bullets': 1, 'keeps-old': 2, 'new-first': 1 },
      tags: ['markdown', 'writing', 'docs'],
    },
    instruction: [
      '# Changelog entry',
      '',
      'File `CHANGELOG.md` chưa tồn tại. Hãy tạo file `CHANGELOG.md`',
      'chứa HAI mục release (mới nhất lên đầu):',
      '',
      '1. Mục mới `1.1.0` ngày `2026-11-19`:',
      '   - Heading đúng dạng `## [1.1.0] - 2026-11-19`.',
      '   - Có section `### Added` với ÍT NHẤT 2 bullet (`- ...`) mô tả',
      '     tính năng mới (nội dung tự viết, phải liên quan tới công',
      '     cụ ghi chú notecli).',
      '',
      '2. Mục cũ `1.0.0` ngày `2026-11-01`, giữ nguyên vẹn từng dòng:',
      '',
      '```markdown',
      '## [1.0.0] - 2026-11-01',
      '',
      '### Added',
      '',
      '- Initial release of notecli.',
      '```',
      '',
      'Mục mới phải đứng TRƯỚC mục `1.0.0`.',
      '',
    ].join('\n'),
    environment: [],
    testScript: [
      '#!/bin/sh',
      '# Chấm task changelog-entry: đủ heading + section + bullet + giữ mục cũ.',
      'if [ ! -f CHANGELOG.md ]; then echo "FAIL has-version"; echo "FAIL has-added"; echo "FAIL has-bullets"; echo "FAIL keeps-old"; echo "FAIL new-first"; exit 1; fi',
      'if grep -qx "## \\[1.1.0\\] - 2026-11-19" CHANGELOG.md; then echo "PASS has-version"; else echo "FAIL has-version"; fi',
      'if grep -qx "### Added" CHANGELOG.md; then echo "PASS has-added"; else echo "FAIL has-added"; fi',
      'if [ "$(grep -c "^- " CHANGELOG.md)" -ge 3 ]; then echo "PASS has-bullets"; else echo "FAIL has-bullets"; fi',
      'if grep -qx "## \\[1.0.0\\] - 2026-11-01" CHANGELOG.md && grep -qx -e "- Initial release of notecli." CHANGELOG.md; then echo "PASS keeps-old"; else echo "FAIL keeps-old"; fi',
      'if [ "$(grep -n "## \\[1.1.0\\]" CHANGELOG.md | cut -d: -f1)" -lt "$(grep -n "## \\[1.0.0\\]" CHANGELOG.md | cut -d: -f1)" ]; then echo "PASS new-first"; else echo "FAIL new-first"; fi',
      '',
    ].join('\n'),
  };
}

/** Toàn bộ task mẫu V4 (theo thứ tự id). */
export function builtinEvalHarnessV4Tasks(): HarborTask[] {
  return [jsonTransformTask(), sortLinesTask(), fixImportTask(), readmeHeadingsTask(), wordCountTask(), logGrepTask(), configFixTask(), changelogEntryTask()];
}

/** Lấy một task mẫu V4 theo id (undefined khi không có). */
export function getBuiltinEvalHarnessV4Task(id: string): HarborTask | undefined {
  return builtinEvalHarnessV4Tasks().find((t) => t.meta.id === id);
}

/**
 * Ghi các task mẫu V4 ra thư mục Harbor chuẩn (mỗi task một thư
 * mục con `<baseDir>/<taskId>/`). Trả về danh sách thư mục đã ghi.
 * Task trên đĩa sau này được load lại qua `loadHarborTaskFromDir`.
 */
export function materializeBuiltinEvalHarnessV4Tasks(baseDir: string): string[] {
  const dirs: string[] = [];
  for (const task of builtinEvalHarnessV4Tasks()) {
    const dir = path.join(baseDir, task.meta.id);
    writeHarborTaskToDir(task, dir);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * Ghi một task mẫu V4 ra thư mục đích (dùng khi user muốn sửa một
 * task mẫu thành task riêng của mình). Ném HarborTaskError khi id
 * không tồn tại (caller báo rõ thay vì ghi file rỗng).
 */
export function materializeBuiltinEvalHarnessV4Task(id: string, baseDir: string): string {
  const task = getBuiltinEvalHarnessV4Task(id);
  if (!task) throw new Error(`Không có task mẫu V4 "${id}".`);
  const dir = path.join(baseDir, task.meta.id);
  writeHarborTaskToDir(task, dir);
  return dir;
}
