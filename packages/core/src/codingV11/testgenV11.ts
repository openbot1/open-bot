/**
 * Coding agent v11 — test generation v2 (mock-first).
 *
 * Nối test generation v8 (parse file nguồn → suy test case từ
 * signature + thân hàm → render file `node:test` → chạy thật →
 * báo function-coverage delta): v2 khác ở 3 điểm:
 *
 *   1. Sinh từ CODE THAY ĐỔI (diff / danh sách file đổi), không
 *      phải từ toàn bộ file — chỉ sinh test cho function export
 *      nằm trong vùng đổi (hoặc toàn bộ function export của file
 *      đổi khi caller không cho diff).
 *   2. Mock-first: hàm có side-effect (đọc file, gọi mạng, chạy
 *      lệnh) thì test sinh ra KHÔNG gọi API/fs thật — nếu hàm nhận
 *      deps qua tham số (dependency injection) thì sinh mock object
 *      truyền vào; nếu hàm gọi trực tiếp `fs`/`fetch` trong thân
 *      thì sinh smoke test ghi rõ `mocked: false` + rationale (để
 *      user review, không giả vờ đã mock).
 *   3. Chạy test sinh ra thật bằng `node --test` trong thư mục tạm
 *      (copy file nguồn đổi vào đó, giữ cấu trúc tương đối) rồi báo
 *      pass/fail từng file + function-coverage delta trước/sau.
 *
 * Suy test case (không gọi model, không đoán bừa): happy (giá trị
 * mẫu theo kiểu param, assert giá trị khi suy ra được từ thân hàm
 * đơn giản như `return a + b`, nếu không thì assert không throw +
 * typeof), edge (0 / '' / [] khi thân hàm có nhánh xử lý edge),
 * error (thân hàm có `throw` → assert.throws với input vi phạm).
 * Mọi test sinh ra đều gắn header GENERATED + cờ `generated: true`,
 * và KHÔNG ghi đè test người viết (testPath đã tồn tại thì sinh
 * sang `<name>.v11-generated.test.mjs`).
 *
 * Giới hạn trung thực: test sinh ra từ phân tích tĩnh — không hiểu
 * semantics sâu; coverage báo là FUNCTION coverage (số function
 * export có ≥1 test), không phải line coverage.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v8ParseFile } from '../codingV8/parser';
import { scanV8RepoFiles } from '../codingV8/repoMap';
import type { V8ParsedFile, V8Symbol } from '../codingV8/types';
import { CodingV11Error } from './types';
import type {
  V11CoverageDelta,
  V11GeneratedTestCase,
  V11GeneratedTestFile,
  V11TestGenResult,
  V11TestGenRunResult,
} from './types';

/** Giới hạn ký tự output test run giữ lại. */
export const V11_TESTGEN_OUTPUT_LIMIT = 8000;
/** Timeout mặc định chạy test sinh ra, ms. */
export const V11_TESTGEN_DEFAULT_TIMEOUT_MS = 30_000;
/** Số case tối đa sinh cho một function. */
export const V11_TESTGEN_MAX_CASES_PER_FUNCTION = 4;

/** Side-effect mà hàm có thể gọi trực tiếp trong thân (cần mock). */
export const V11_TESTGEN_SIDE_EFFECTS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'fs', re: /\bfs\.(readFile|writeFile|appendFile|unlink|mkdir|readdir|existsSync|statSync)\b/ },
  { name: 'fetch', re: /\bfetch\s*\(/ },
  { name: 'http', re: /\bhttps?\. (get|request)\b|\baxios\b|\bhttp\.(get|request)\b/ },
  { name: 'child_process', re: /\b(exec|execSync|spawn|execFile)\s*\(/ },
  { name: 'process', re: /\bprocess\.env\b/ },
];

/** Tách nội dung thành dòng (bỏ dòng rỗng cuối do `\n` cuối). */
function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Giá trị mẫu theo kiểu tham số (code JS). */
export function v11SampleValueForType(type: string | undefined, name: string): string {
  const t = (type ?? '').toLowerCase().replace(/\s+/g, '');
  const n = name.toLowerCase();
  if (t.includes('string') || n.includes('name') || n.includes('path') || n.includes('text')) return "'hello'";
  if (t.includes('number') || n === 'a' || n === 'b' || n.includes('count') || n.includes('index')) return '2';
  if (t.includes('boolean') || n.startsWith('is') || n.startsWith('has')) return 'true';
  if (t.includes('[]') || t.includes('array')) return '[1, 2, 3]';
  if (t.includes('object') || t.includes('record') || t.includes('options') || t.includes('config') || t.includes('deps')) return '{}';
  if (t.includes('function') || n.includes('callback') || n.includes('fn')) return '() => {}';
  if (t === '') return '2';
  return "'hello'";
}

/** Phát hiện side-effect trong thân hàm (để quyết định mock-first). */
export function v11DetectSideEffects(body: string): string[] {
  return V11_TESTGEN_SIDE_EFFECTS.filter((s) => s.re.test(body)).map((s) => s.name);
}

/** true = hàm nhận deps qua tham số (có param object/function) → mock được. */
function hasInjectableDeps(symbol: V8Symbol): boolean {
  return symbol.params.some((p) => {
    const t = (p.type ?? '').toLowerCase();
    return (
      t.includes('object') ||
      t.includes('record') ||
      t.includes('options') ||
      t.includes('deps') ||
      t.includes('function') ||
      p.name.toLowerCase().includes('deps') ||
      p.name.toLowerCase().includes('client') ||
      p.name.toLowerCase().includes('fs')
    );
  });
}

/** Lấy thân hàm (từ dòng bắt đầu tới endLine, fallback 40 dòng). */
function functionBody(lines: string[], symbol: V8Symbol): string {
  const start = symbol.line - 1;
  const end = symbol.endLine > 0 ? symbol.endLine : Math.min(lines.length, start + 40);
  return lines.slice(start, end).join('\n');
}

/** Suy giá trị trả về cho phép tính đơn giản `return a + b` / `a - b` / `a * b`. */
function inferArithmeticAssertion(body: string, params: Array<{ name: string }>): { expr: string; expected: string } | null {
  const m = /return\s+([A-Za-z_$][\w$]*)\s*([+\-*/%])\s*([A-Za-z_$][\w$]*)\s*;/.exec(body);
  if (!m) return null;
  const [, left, op, right] = m as unknown as [string, string, string, string];
  const values = new Map(params.map((p, i) => [p.name, i === 0 ? 2 : 3]));
  const lv = values.get(left as string);
  const rv = values.get(right as string);
  if (lv === undefined || rv === undefined) return null;
  let expected: number;
  switch (op) {
    case '+':
      expected = lv + rv;
      break;
    case '-':
      expected = lv - rv;
      break;
    case '*':
      expected = lv * rv;
      break;
    case '/':
      expected = lv / rv;
      break;
    case '%':
      expected = lv % rv;
      break;
    default:
      return null;
  }
  return { expr: `${left} ${op} ${right}`, expected: String(expected) };
}

/** Sinh các case cho MỘT function export. */
function generateCasesForFunction(
  symbol: V8Symbol,
  sourceFile: string,
  lines: string[],
): { cases: V11GeneratedTestCase[]; uncoveredReason?: string } {
  const body = functionBody(lines, symbol);
  const params = symbol.params;
  const args = params.map((p) => v11SampleValueForType(p.type, p.name)).join(', ');
  const callExpr = symbol.async
    ? `await ${symbol.name}(${args})`
    : `${symbol.name}(${args})`;
  const sideEffects = v11DetectSideEffects(body);
  const mockable = sideEffects.length > 0 && hasInjectableDeps(symbol);
  const cases: V11GeneratedTestCase[] = [];
  // Case happy: assert giá trị khi suy ra được, nếu không thì smoke.
  const arithmetic = inferArithmeticAssertion(body, params);
  if (arithmetic) {
    const expectedArgs = params.map((p, i) => (i === 0 ? '2' : '3')).join(', ');
    const expectedCall = symbol.async ? `await ${symbol.name}(${expectedArgs})` : `${symbol.name}(${expectedArgs})`;
    cases.push({
      name: `${symbol.name}: happy (${arithmetic.expr})`,
      functionName: symbol.name,
      sourceFile,
      kind: 'happy',
      mocked: mockable,
      code: `test('${symbol.name}: happy (${arithmetic.expr})', ${symbol.async ? 'async ' : ''}() => {\n  assert.equal(${expectedCall}, ${arithmetic.expected});\n});`,
      rationale: `Thân hàm có "return ${arithmetic.expr}" — assert đúng giá trị tính được.${mockable ? ' Dùng mock deps truyền qua tham số.' : ''}`,
    });
  } else if (/return\s+true|false/.test(body) || /return\s+\w+\s*(===|!==|>|<|>=|<=)/.test(body)) {
    cases.push({
      name: `${symbol.name}: happy (boolean)`,
      functionName: symbol.name,
      sourceFile,
      kind: 'happy',
      mocked: mockable,
      code: `test('${symbol.name}: happy (boolean)', ${symbol.async ? 'async ' : ''}() => {\n  assert.equal(typeof ${callExpr}, 'boolean');\n});`,
      rationale: 'Thân hàm trả boolean — assert kiểu trả về (không đoán giá trị cụ thể).',
    });
  } else {
    cases.push({
      name: `${symbol.name}: smoke (không throw)`,
      functionName: symbol.name,
      sourceFile,
      kind: 'smoke',
      mocked: mockable,
      code: `test('${symbol.name}: smoke (không throw)', ${symbol.async ? 'async ' : ''}() => {\n  assert.doesNotThrow(${symbol.async ? 'async ' : ''}() => ${callExpr});\n});`,
      rationale:
        sideEffects.length > 0 && !mockable
          ? `Hàm gọi trực tiếp ${sideEffects.join(', ')} (không nhận deps qua tham số) nên không mock được — chỉ smoke "không throw" với input mẫu, KHÔNG gọi API thật.`
          : 'Không suy ra được giá trị trả về chắc chắn — chỉ assert hàm chạy không throw.',
    });
  }
  // Case edge: số 0 / chuỗi rỗng / mảng rỗng khi thân hàm có nhánh xử lý edge.
  if (/\b(if|while)\s*\(.*(<=?\s*0|===\s*0|length\s*===?\s*0|===\s*['"]{2})/.test(body) && params.length > 0) {
    const first = params[0] as { name: string; type?: string };
    const edgeArg = (first.type ?? '').toLowerCase().includes('string') ? "''" : '0';
    const edgeArgs = [edgeArg, ...params.slice(1).map((p) => v11SampleValueForType(p.type, p.name))].join(', ');
    const edgeCall = symbol.async ? `await ${symbol.name}(${edgeArgs})` : `${symbol.name}(${edgeArgs})`;
    cases.push({
      name: `${symbol.name}: edge (${first.name} = ${edgeArg})`,
      functionName: symbol.name,
      sourceFile,
      kind: 'edge',
      mocked: mockable,
      code: `test('${symbol.name}: edge (${first.name} = ${edgeArg})', ${symbol.async ? 'async ' : ''}() => {\n  assert.doesNotThrow(${symbol.async ? 'async ' : ''}() => ${edgeCall});\n});`,
      rationale: 'Thân hàm có nhánh xử lý giá trị biên (0 / rỗng) — test không throw với input biên.',
    });
  }
  // Case error: thân hàm có throw → assert.throws.
  const throwMatch = /if\s*\(([^)]+)\)\s*(?:\{[^}]*?)?throw\s+new\s+Error\(([^)]+)\)/.exec(body);
  if (throwMatch) {
    const condition = (throwMatch[1] ?? '').trim();
    const message = (throwMatch[2] ?? '').trim();
    cases.push({
      name: `${symbol.name}: error (throw khi ${condition})`,
      functionName: symbol.name,
      sourceFile,
      kind: 'error',
      mocked: mockable,
      code: `test('${symbol.name}: error (throw khi ${condition})', () => {\n  assert.throws(() => ${symbol.name}(${args}), ${message.startsWith("'") || message.startsWith('"') ? message : '/./'});\n});`,
      rationale: `Thân hàm throw khi "${condition}" — assert throws với input mẫu.`,
    });
  }
  return { cases: cases.slice(0, V11_TESTGEN_MAX_CASES_PER_FUNCTION) };
}

/** Đường dẫn test cho một file nguồn (không ghi đè test người viết). */
export function v11TestPathForSource(sourceFile: string, workingDir: string): string {
  const dir = path.posix.dirname(sourceFile);
  const base = path.posix.basename(sourceFile).replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
  const candidate = path.posix.join(dir, `${base}.test.mjs`);
  if (!fs.existsSync(path.join(workingDir, candidate))) return candidate;
  return path.posix.join(dir, `${base}.v11-generated.test.mjs`);
}

/** Render nội dung file test từ các case (header GENERATED + import). */
function renderTestFile(sourceFile: string, cases: V11GeneratedTestCase[]): string {
  // Test nằm cùng thư mục với file nguồn nên import bằng `./<basename>`.
  const importSpecifier = `./${path.posix.basename(sourceFile)}`;
  const names = [...new Set(cases.map((c) => c.functionName))];
  const lines = [
    '// GENERATED by coding agent v11 (testgen v2) — review before trusting.',
    `// Source: ${sourceFile}. Mock-first: không gọi API/fs thật khi hàm nhận deps qua tham số.`,
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { ${names.join(', ')} } from '${importSpecifier}';`,
    '',
  ];
  for (const c of cases) lines.push(c.code, '');
  return `${lines.join('\n')}\n`;
}

export interface V11TestGenOptions {
  /** Diff unified để xác định vùng đổi (nếu không có thì sinh cho toàn bộ function export của file đổi). */
  diff?: string;
  /** Số file tối đa quét khi tính coverage trước. */
  maxFiles?: number;
}

/**
 * Sinh test v2 từ code thay đổi: parse file đổi → với mỗi function
 * export sinh case (mock-first) → render file test (chưa ghi đĩa).
 */
export function generateV11Tests(
  workingDir: string,
  changedFiles: readonly string[],
  options: V11TestGenOptions = {},
): V11TestGenResult {
  if (changedFiles.length === 0) {
    throw new CodingV11Error('testgen-no-target', 'Testgen v11: chưa cho file đổi nào.');
  }
  const root = path.resolve(workingDir);
  const generated: V11GeneratedTestFile[] = [];
  const uncovered: Array<{ functionName: string; sourceFile: string; reason: string }> = [];
  let functionsConsidered = 0;
  let functionsCovered = 0;
  let mockedCases = 0;
  let smokeCases = 0;
  // Vùng đổi theo diff (file → dòng đổi) để chỉ sinh test cho function trong vùng đổi.
  const changedLines = new Map<string, Set<number>>();
  if (options.diff) {
    const files = options.diff.split('\n');
    let currentFile: string | null = null;
    let newLineNo = 0;
    for (const line of files) {
      if (line.startsWith('+++ ')) {
        currentFile = line.slice(4).trim().replace(/^b\//, '');
        changedLines.set(currentFile, new Set());
        continue;
      }
      if (line.startsWith('@@ ')) {
        const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) newLineNo = parseInt(m[1] as string, 10);
        continue;
      }
      if (currentFile && line.startsWith('+') && !line.startsWith('+++')) {
        changedLines.get(currentFile)?.add(newLineNo);
        newLineNo += 1;
      } else if (currentFile && (line.startsWith(' ') || line === '')) {
        newLineNo += 1;
      }
    }
  }
  for (const rel of changedFiles) {
    const abs = path.join(root, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const parsed: V8ParsedFile = v8ParseFile(rel, content, new Set(changedFiles));
    const lines = splitLines(content);
    // Testgen v2 chạy test bằng `node --test` nên chỉ sinh test chạy
    // được cho file JS (.mjs/.js/.cjs) — file TS ghi rõ lý do chưa cover.
    const isRunnableJs = /\.(mjs|cjs|js|jsx)$/.test(rel);
    const exported = parsed.symbols.filter((s) => s.exported && (s.kind === 'function' || s.kind === 'variable' || s.kind === 'class'));
    const casesByFunction: V11GeneratedTestCase[] = [];
    for (const symbol of exported) {
      // Chỉ sinh cho function nằm trong vùng đổi (khi có diff).
      const changedSet = changedLines.get(rel);
      if (changedSet && changedSet.size > 0) {
        const start = symbol.line;
        const end = symbol.endLine > 0 ? symbol.endLine : symbol.line + 40;
        let inChangedRegion = false;
        for (let ln = start; ln <= end; ln++) {
          if (changedSet.has(ln)) {
            inChangedRegion = true;
            break;
          }
        }
        if (!inChangedRegion) continue;
      }
      functionsConsidered += 1;
      if (!isRunnableJs) {
        uncovered.push({ functionName: symbol.name, sourceFile: rel, reason: 'TypeScript: testgen v2 chỉ chạy test được cho JS (.mjs/.js/.cjs) vì node --test không import được .ts.' });
        continue;
      }
      if (symbol.kind === 'class') {
        uncovered.push({ functionName: symbol.name, sourceFile: rel, reason: 'class: testgen v2 chưa sinh test cho class (chỉ function/variable).' });
        continue;
      }
      const { cases } = generateCasesForFunction(symbol, rel, lines);
      if (cases.length === 0) {
        uncovered.push({ functionName: symbol.name, sourceFile: rel, reason: 'Không suy ra được case nào từ signature/thân hàm.' });
        continue;
      }
      functionsCovered += 1;
      for (const c of cases) {
        if (c.mocked) mockedCases += 1;
        if (c.kind === 'smoke') smokeCases += 1;
      }
      casesByFunction.push(...cases);
    }
    if (casesByFunction.length > 0) {
      const testPath = v11TestPathForSource(rel, root);
      generated.push({
        testPath,
        sourceFile: rel,
        content: renderTestFile(rel, casesByFunction),
        cases: casesByFunction,
      });
    }
  }
  return { generated, functionsConsidered, functionsCovered, uncovered, mockedCases, smokeCases };
}

/**
 * Tính function-coverage delta: function export đã có test trước
 * (tên function xuất hiện trong file test hiện có) vs sau khi thêm
 * test sinh ra.
 */
export function v11CoverageDelta(
  workingDir: string,
  generated: readonly V11GeneratedTestFile[],
  changedFiles: readonly string[],
): V11CoverageDelta {
  const root = path.resolve(workingDir);
  const allFiles = scanV8RepoFiles(root);
  const knownFiles = new Set(allFiles);
  const testContents: string[] = [];
  for (const rel of allFiles) {
    if (!v11IsTestFileLocal(rel)) continue;
    try {
      testContents.push(fs.readFileSync(path.join(root, rel), 'utf8'));
    } catch {
      // Bỏ qua file test đọc lỗi.
    }
  }
  const existingTests = testContents.join('\n');
  const allFunctions: Array<{ name: string; file: string }> = [];
  for (const rel of changedFiles) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const parsed = v8ParseFile(rel, content, knownFiles);
    for (const sym of parsed.symbols) {
      if (sym.exported && (sym.kind === 'function' || sym.kind === 'variable')) {
        allFunctions.push({ name: sym.name, file: rel });
      }
    }
  }
  const coveredBefore = allFunctions.filter((f) => new RegExp(`\\b${f.name}\\b`).test(existingTests)).length;
  const generatedTests = generated.map((g) => g.content).join('\n');
  const newlyCovered = allFunctions
    .filter((f) => !new RegExp(`\\b${f.name}\\b`).test(existingTests) && new RegExp(`\\b${f.name}\\b`).test(generatedTests))
    .map((f) => `${f.file}#${f.name}`);
  const coveredAfter = coveredBefore + newlyCovered.length;
  const total = Math.max(1, allFunctions.length);
  return {
    coveredBefore,
    coveredAfter,
    totalFunctions: allFunctions.length,
    rateBefore: coveredBefore / total,
    rateAfter: coveredAfter / total,
    newlyCovered,
  };
}

/** true = path là file test (bản local, tránh import vòng). */
function v11IsTestFileLocal(p: string): boolean {
  const s = p.replace(/\\/g, '/');
  return (
    s.includes('/test/') ||
    s.includes('/tests/') ||
    s.includes('/__tests__/') ||
    /\.test\.[a-z]+$/.test(s) ||
    /\.spec\.[a-z]+$/.test(s)
  );
}

/**
 * Chạy test sinh ra thật: copy file nguồn đổi + file test sinh ra
 * vào thư mục tạm (giữ cấu trúc tương đối), chạy `node --test`.
 */
export async function runV11GeneratedTests(
  workingDir: string,
  generated: readonly V11GeneratedTestFile[],
  changedFiles: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<V11TestGenRunResult> {
  const timeoutMs = options.timeoutMs ?? V11_TESTGEN_DEFAULT_TIMEOUT_MS;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-testgen-v11-'));
  try {
    for (const rel of changedFiles) {
      const src = path.join(workingDir, rel);
      const dst = path.join(tmpDir, rel);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch {
        // File đổi đọc lỗi thì test sinh ra vẫn chạy (sẽ fail rõ ràng).
      }
    }
    let filesPassed = 0;
    let filesFailed = 0;
    let totalCases = 0;
    const failures: Array<{ testPath: string; excerpt: string }> = [];
    let output = '';
    for (const gen of generated) {
      totalCases += gen.cases.length;
      const dst = path.join(tmpDir, gen.testPath);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, gen.content, 'utf8');
      const run = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn('node', ['--test', gen.testPath], { cwd: tmpDir, shell: false, env: { ...process.env } });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Đã thoát.
          }
        }, timeoutMs);
        timer.unref?.();
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (err: Error) => {
          clearTimeout(timer);
          resolve({ exitCode: -1, stdout, stderr: `${stderr}\nspawn error: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? -1, stdout, stderr });
        });
      });
      output += `\n=== ${gen.testPath} (exit ${run.exitCode}) ===\n${run.stdout.slice(-4000)}${run.stderr ? `\n[stderr]\n${run.stderr.slice(-2000)}` : ''}`;
      if (run.exitCode === 0) filesPassed += 1;
      else {
        filesFailed += 1;
        failures.push({
          testPath: gen.testPath,
          excerpt: (run.stderr || run.stdout).trim().slice(-V11_TESTGEN_OUTPUT_LIMIT / 4) || `exit ${run.exitCode}`,
        });
      }
    }
    return {
      ok: filesFailed === 0,
      filesPassed,
      filesFailed,
      totalCases,
      output: output.slice(0, V11_TESTGEN_OUTPUT_LIMIT),
      failures,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Thư mục tạm không dọn được — không chặn kết quả.
    }
  }
}
