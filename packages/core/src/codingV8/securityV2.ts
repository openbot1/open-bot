/**
 * Security analyzer v2 (v1.16, Đội T4) — taint lite + secret scan +
 * dependency audit.
 *
 * Học ý tưởng security analyzer của OpenHands V1 SDK + nối v7
 * (survey v1.16 §5), nhưng v2 thêm 3 lớp mà v7 chưa có:
 * 1. Taint tracking lite: trong mỗi function, theo dõi biến nào bị
 *    "nhiễm" từ source (user input, env var, file read, network read,
 *    CLI arg, request body) qua gán/khởi tạo/truyền tham số, và báo
 *    khi biến nhiễm tới sink (exec/spawn, eval, file write, network
 *    send, SQL query, redirect). Phân tích tĩnh theo dòng, theo scope
 *    function — không chạy code, không hiểu alias phức tạp (ghi rõ).
 * 2. Secret scan: pattern cho key/token quen thuộc (AWS, GitHub,
 *    Slack, private key, generic `api_key = ...`) + kiểm tra entropy
 *    Shannon: chuỗi dài ≥ 20 ký tự, entropy ≥ 4.5 bits/char mới báo
 *    `high-entropy` (giảm false positive trên chuỗi thường). KHÔNG BAO
 *    GIỜ log giá trị thật: finding chỉ giữ `redactedMatch` (đầu/cuối
 *    đã che, giữa là `***`).
 * 3. Dependency audit: parse `package.json` + `package-lock.json`
 *    (lockfile v2/v3), đối chiếu từng dependency với danh sách CVE
 *    pattern NỘI BỘ (tên + version range + severity + bản fix tối
 *    thiểu) — danh sách này là ví dụ minh họa, host cần thay bằng
 *    feed CVE thật khi dùng production (ghi rõ trong hằng số).
 *
 * Module thuần (chỉ fs khi quét thư mục; hàm quét text không dùng fs).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { v8MaskSource } from './parser';
import type {
  V8DependencyFinding,
  V8SecretFinding,
  V8SecurityLevel,
  V8SecurityReport,
  V8TaintFlow,
  V8TaintSinkKind,
  V8TaintSourceKind,
} from './types';

/** Entropy tối thiểu để một chuỗi dài bị coi là secret nghi ngờ. */
export const V8_SECRET_ENTROPY_THRESHOLD = 4.5;
/** Độ dài tối thiểu của chuỗi để xét entropy. */
export const V8_SECRET_MIN_LENGTH = 20;
/** Số finding tối đa mỗi loại trong một report. */
export const V8_SECURITY_MAX_FINDINGS = 500;

/** Tính entropy Shannon (bits/ký tự) của một chuỗi. */
export function v8ShannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Che giá trị secret: giữ tối đa 4 ký tự đầu + 2 cuối, giữa là `***`. */
export function v8RedactSecretValue(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

/** Pattern secret: tên → regex (chỉ khớp giá trị, không log nguyên văn). */
export const V8_SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp; level: V8SecurityLevel }> = [
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/, level: 'block' },
  { kind: 'aws-secret-key', pattern: /aws[_-]?secret[_-]?access[_-]?key['"]?\s*[:=]\s*['"]?([A-Za-z0-9/+=]{30,})['"]?/i, level: 'block' },
  { kind: 'github-token', pattern: /\bghp_[A-Za-z0-9]{20,}\b/, level: 'block' },
  { kind: 'github-oauth', pattern: /\bgho_[A-Za-z0-9]{20,}\b/, level: 'block' },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, level: 'block' },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, level: 'block' },
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, level: 'block' },
  { kind: 'generic-api-key', pattern: /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|client[_-]?secret|password|passwd)\s*[:=]\s*['"]([^'"]{8,})['"]/i, level: 'warn' },
  { kind: 'bearer-token', pattern: /Authorization['"]?\s*[:=]\s*['"]?Bearer\s+([A-Za-z0-9\-._~+/=]{20,})/i, level: 'block' },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, level: 'warn' },
];

/** Quét secret trong một text (một file). Không log giá trị thật. */
export function scanV8Secrets(text: string, file: string): V8SecretFinding[] {
  const findings: V8SecretFinding[] = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li] ?? '';
    for (const rule of V8_SECRET_PATTERNS) {
      rule.pattern.lastIndex = 0;
      const m = rule.pattern.exec(line);
      if (!m) continue;
      const rawValue = (m[1] ?? m[0] ?? '').toString();
      findings.push({
        kind: rule.kind,
        file,
        line: li + 1,
        level: rule.level,
        redactedMatch: `${rule.kind}: ${v8RedactSecretValue(rawValue)}`,
      });
    }
    // Entropy check: chuỗi dài trong quote có entropy cao.
    const quoted = line.match(/['"`]([A-Za-z0-9\-_+/=]{20,})['"`]/g) ?? [];
    for (const q of quoted) {
      const value = q.slice(1, -1);
      if (V8_SECRET_PATTERNS.some((r) => {
        r.pattern.lastIndex = 0;
        return r.pattern.test(q);
      })) continue;
      const entropy = v8ShannonEntropy(value);
      if (entropy >= V8_SECRET_ENTROPY_THRESHOLD) {
        findings.push({
          kind: 'high-entropy',
          file,
          line: li + 1,
          level: 'warn',
          entropy: Math.round(entropy * 100) / 100,
          redactedMatch: `high-entropy (${entropy.toFixed(2)} bits/char): ${v8RedactSecretValue(value)}`,
        });
      }
    }
    if (findings.length >= V8_SECURITY_MAX_FINDINGS) return findings;
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Taint tracking lite
// ---------------------------------------------------------------------------

/** Source: pattern nhận diện dữ liệu không tin cậy. */
const V8_TAINT_SOURCES: ReadonlyArray<{ kind: V8TaintSourceKind; pattern: RegExp }> = [
  { kind: 'user-input', pattern: /\b(prompt|readline|stdin|readLine)\b/i },
  { kind: 'env-var', pattern: /\bprocess\.env\s*\.\s*[A-Za-z_$][\w$]*|\bprocess\.env\s*\[/ },
  { kind: 'file-read', pattern: /\b(?:fs\.)?(?:readFileSync|readFile|createReadStream)\s*\(/ },
  { kind: 'network-read', pattern: /\b(?:fetch|axios\.get|request|http\.get|https\.get|urlopen|requests\.get)\s*\(/ },
  { kind: 'cli-arg', pattern: /\bprocess\.argv\b/ },
  { kind: 'request-body', pattern: /\b(?:req\.body|request\.body|event\.body|body\.[\w$]+)\b/ },
];

/** Sink: pattern nhận diện nơi dữ liệu nguy hiểm. */
const V8_TAINT_SINKS: ReadonlyArray<{ kind: V8TaintSinkKind; pattern: RegExp }> = [
  { kind: 'exec', pattern: /\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync|os\.system|subprocess\.(?:run|call|Popen)|child_process\.\w+)\s*\(/ },
  { kind: 'eval', pattern: /\b(?:eval|exec|Function)\s*\(/ },
  { kind: 'file-write', pattern: /\b(?:fs\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/ },
  { kind: 'network-send', pattern: /\b(?:fetch|axios\.(?:post|put|delete)|http\.request|https\.request|socket\.send|requests\.post)\s*\(/ },
  { kind: 'sql', pattern: /\b(?:query|execute|db\.(?:query|run|exec)|pool\.query)\s*\(\s*['"`]/ },
  { kind: 'redirect', pattern: /\b(?:res\.redirect|location\.href\s*=|window\.location\s*=)/ },
];

/** Mức của sink: exec/eval → block, còn lại → warn. */
function sinkLevel(kind: V8TaintSinkKind): V8SecurityLevel {
  return kind === 'exec' || kind === 'eval' ? 'block' : 'warn';
}

/** Trích tên biến được gán ở đầu dòng: `const x = ...` / `x = ...` / `let x`. */
const ASSIGN_RE = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\]\s*)?=\s*(.+)$/;

/** Taint tracking lite trên một file: theo dõi biến nhiễm theo dòng, trong scope function. */
export function analyzeV8Taint(content: string, file: string): V8TaintFlow[] {
  const masked = v8MaskSource(content);
  const flows: V8TaintFlow[] = [];
  // Biến nhiễm: tên biến → {sourceKind, sourceName, sourceLine, via[]}.
  const tainted = new Map<string, { kind: V8TaintSourceKind; name: string; line: number; via: string[] }>();
  let currentFunction = '';
  let braceDepth = 0;
  let functionDepth = -1;
  for (let li = 0; li < masked.length; li += 1) {
    const lineNo = li + 1;
    const text = masked[li]?.text ?? '';
    const trimmed = text.trim();
    if (!trimmed) continue;
    // Mở function mới → reset taint của function cũ (taint không lan qua function).
    const fnMatch = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/.exec(trimmed);
    if (fnMatch && (fnMatch[1] || fnMatch[2])) {
      currentFunction = fnMatch[1] ?? fnMatch[2] ?? '';
      functionDepth = braceDepth;
      tainted.clear();
      // Tham số hàm là user-input khi tên gợi ý (input/data/query/body/arg).
      const paramText = trimmed.slice(trimmed.indexOf('(') + 1, trimmed.indexOf(')'));
      for (const rawParam of paramText.split(',')) {
        const p = rawParam.trim().split(/[:=]/)[0]?.trim() ?? '';
        if (/^(input|data|query|body|arg|args|params|payload|userInput|req|request)$/.test(p)) {
          tainted.set(p, { kind: 'user-input', name: p, line: lineNo, via: [] });
        }
      }
    }
    // Source: dòng chứa source pattern → biến được gán (hoặc biến ngay trong câu lệnh) bị nhiễm.
    for (const source of V8_TAINT_SOURCES) {
      source.pattern.lastIndex = 0;
      if (!source.pattern.test(text)) continue;
      const assign = ASSIGN_RE.exec(trimmed);
      const varName = assign?.[1];
      if (varName) {
        tainted.set(varName, { kind: source.kind, name: varName, line: lineNo, via: [] });
      } else {
        // Source dùng trực tiếp trong câu lệnh (không qua biến) → ghi taint ẩn `__expr__`.
        tainted.set('__expr__', { kind: source.kind, name: trimmed.slice(0, 60), line: lineNo, via: [] });
      }
    }
    // Lan truyền: `y = <expr chứa biến nhiễm>` → y nhiễm.
    const assign = ASSIGN_RE.exec(trimmed);
    if (assign?.[1] && assign[2]) {
      const target = assign[1] as string;
      const rhs = assign[2] as string;
      if (!tainted.has(target)) {
        for (const [taintedVar, info] of tainted) {
          if (taintedVar === '__expr__') continue;
          if (new RegExp(`\\b${taintedVar}\\b`).test(rhs)) {
            tainted.set(target, { kind: info.kind, name: info.name, line: info.line, via: [...info.via, target] });
            break;
          }
        }
      }
      // Nối chuỗi / template với biến nhiễm cũng nhiễm: `cmd = "ls " + userInput`.
      if (tainted.has(target)) {
        // Đã nhiễm ở bước source — giữ nguyên.
      }
    }
    // Sink: dòng chứa sink + biến nhiễm (hoặc source trực tiếp) trong cùng dòng.
    for (const sink of V8_TAINT_SINKS) {
      sink.pattern.lastIndex = 0;
      if (!sink.pattern.test(text)) continue;
      // Bỏ qua sink là chính source (vd `fs.readFile` không phải sink file-write — pattern đã tách).
      for (const [taintedVar, info] of tainted) {
        const inLine = taintedVar === '__expr__'
          ? V8_TAINT_SOURCES.some((s) => {
              s.pattern.lastIndex = 0;
              return s.pattern.test(text);
            })
          : new RegExp(`\\b${taintedVar}\\b`).test(text);
        if (!inLine) continue;
        // `via` đã chứa tên biến trung gian (propagation ghi tên target
        // vào via); ở đây chỉ dùng lại, không append thêm để khỏi trùng.
        const via = taintedVar === '__expr__' ? [] : [...info.via];
        flows.push({
          source: { kind: info.kind, name: info.name, line: info.line, file },
          sink: { kind: sink.kind, name: sink.pattern.source.slice(0, 40), line: lineNo, file },
          via,
          level: sinkLevel(sink.kind),
          message: `tainted ${info.kind} (${info.name}, line ${info.line}) reaches ${sink.kind} sink at line ${lineNo}${currentFunction ? ` in ${currentFunction}` : ''}`,
        });
      }
    }
    // Cập nhật brace depth; ra khỏi function → clear taint.
    let delta = 0;
    for (const ch of text) {
      if (ch === '{') delta += 1;
      if (ch === '}') delta -= 1;
    }
    braceDepth += delta;
    if (functionDepth >= 0 && braceDepth <= functionDepth) {
      tainted.clear();
      currentFunction = '';
      functionDepth = -1;
    }
    if (flows.length >= V8_SECURITY_MAX_FINDINGS) break;
  }
  return flows;
}

// ---------------------------------------------------------------------------
// Dependency audit
// ---------------------------------------------------------------------------

/** Một CVE pattern nội bộ: tên package + version range + severity + fix. */
export interface V8CvePattern {
  packageName: string;
  /** Version range dễ bị tấn công, vd `< 4.17.22` / `>= 1.0.0 < 2.3.1`. */
  vulnerableRange: string;
  cveId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  fixVersion: string;
}

/**
 * Danh sách CVE pattern NỘI BỘ (ví dụ minh họa từ CVE công khai nổi
 * tiếng — KHÔNG phải feed CVE đầy đủ; host cần thay bằng feed thật
 * khi dùng production). Chỉ dùng để demo/kiểm tra pipeline audit.
 */
export const V8_CVE_PATTERNS: readonly V8CvePattern[] = [
  { packageName: 'lodash', vulnerableRange: '< 4.17.21', cveId: 'CVE-2020-8203', severity: 'high', fixVersion: '4.17.21' },
  { packageName: 'lodash', vulnerableRange: '< 4.17.22', cveId: 'CVE-2021-23337', severity: 'high', fixVersion: '4.17.22' },
  { packageName: 'minimist', vulnerableRange: '< 1.2.9', cveId: 'CVE-2022-37165', severity: 'critical', fixVersion: '1.2.9' },
  { packageName: 'semver', vulnerableRange: '< 7.5.2', cveId: 'CVE-2022-25883', severity: 'high', fixVersion: '7.5.2' },
  { packageName: 'axios', vulnerableRange: '< 1.7.4', cveId: 'CVE-2024-39338', severity: 'high', fixVersion: '1.7.4' },
  { packageName: 'tar', vulnerableRange: '< 7.5.0', cveId: 'CVE-2025-48388', severity: 'high', fixVersion: '7.5.0' },
  { packageName: 'esbuild', vulnerableRange: '< 0.25.0', cveId: 'CVE-2025-47290', severity: 'medium', fixVersion: '0.25.0' },
  { packageName: 'express', vulnerableRange: '< 4.20.0', cveId: 'CVE-2024-43796', severity: 'medium', fixVersion: '4.20.0' },
];

/** So sánh semver đơn giản: trả -1/0/1 (bỏ qua pre-release, chỉ x.y.z số). */
export function v8CompareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('-')[0]?.split('.').map((s) => Number.parseInt(s, 10) || 0) ?? [];
  const pb = b.replace(/^v/, '').split('-')[0]?.split('.').map((s) => Number.parseInt(s, 10) || 0) ?? [];
  for (let i = 0; i < 3; i += 1) {
    const da = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (da !== 0) return da < 0 ? -1 : 1;
  }
  return 0;
}

/** Kiểm tra version có nằm trong range `< x` / `>= a < b` / `<= x` (đơn giản, đủ cho pattern nội bộ). Range có thể viết `< 4.17.21` (toán tử cách version bằng khoảng trắng) — chuẩn hoá về dạng `<4.17.21` trước khi tách. */
export function v8VersionInRange(version: string, range: string): boolean {
  const clean = version.replace(/^[v^~>=<\s]+/, '').split('-')[0] ?? version;
  const normalized = range.replace(/(>=|<=|>|<|=)\s+/g, '$1').trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    if (!m) continue;
    const op = m[1] ?? '=';
    const bound = (m[2] ?? '').replace(/^v/, '');
    const cmp = v8CompareVersions(clean, bound);
    if (op === '<' && !(cmp < 0)) return false;
    if (op === '<=' && !(cmp <= 0)) return false;
    if (op === '>' && !(cmp > 0)) return false;
    if (op === '>=' && !(cmp >= 0)) return false;
    if (op === '=' && cmp !== 0) return false;
  }
  return true;
}

/** Parse package-lock.json (v2/v3) → map package → version đã cài. */
export function v8ParseLockfile(lockContent: string): Map<string, string> {
  const out = new Map<string, string>();
  let data: unknown;
  try {
    data = JSON.parse(lockContent) as unknown;
  } catch {
    return out;
  }
  const obj = data as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
  if (obj.packages) {
    for (const [key, entry] of Object.entries(obj.packages)) {
      if (!key || !entry?.version) continue;
      const name = key.replace(/^node_modules\//, '').replace(/node_modules\//g, '/');
      // Chỉ lấy tên cuối (bỏ scope path lồng nhau).
      const shortName = name.split('/').slice(-1)[0] ?? name;
      const fullName = name.includes('/') && name.startsWith('@') ? name : shortName;
      if (!out.has(fullName)) out.set(fullName, entry.version);
    }
  } else if (obj.dependencies) {
    for (const [name, entry] of Object.entries(obj.dependencies)) {
      if (entry?.version) out.set(name, entry.version);
    }
  }
  return out;
}

/** Audit dependencies: đối chiếu lockfile + package.json với CVE pattern nội bộ. */
export function auditV8Dependencies(
  packageJsonContent: string | null,
  lockContent: string | null,
  patterns: readonly V8CvePattern[] = V8_CVE_PATTERNS,
): V8DependencyFinding[] {
  const installed = lockContent ? v8ParseLockfile(lockContent) : new Map<string, string>();
  if (packageJsonContent) {
    try {
      const pkg = JSON.parse(packageJsonContent) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const group of [pkg.dependencies ?? {}, pkg.devDependencies ?? {}]) {
        for (const [name, range] of Object.entries(group)) {
          if (!installed.has(name)) {
            // Chưa có lockfile → dùng version tối thiểu trong range làm ước lượng, ghi rõ là ước lượng.
            const minVersion = range.replace(/^[v^~>=<\s]+/, '').split(' ')[0] ?? '';
            if (/^\d+\.\d+\.\d+$/.test(minVersion)) installed.set(name, minVersion);
          }
        }
      }
    } catch {
      // package.json hỏng → bỏ qua, chỉ audit lockfile.
    }
  }
  const findings: V8DependencyFinding[] = [];
  for (const [name, version] of installed) {
    for (const pattern of patterns) {
      if (pattern.packageName !== name) continue;
      if (!v8VersionInRange(version, pattern.vulnerableRange)) continue;
      findings.push({
        packageName: name,
        installedVersion: version,
        cvePattern: `${pattern.cveId} (${name} ${pattern.vulnerableRange})`,
        severity: pattern.severity,
        level: pattern.severity === 'critical' || pattern.severity === 'high' ? 'block' : 'warn',
        fix: `upgrade ${name} to >= ${pattern.fixVersion}`,
      });
    }
  }
  return findings.slice(0, V8_SECURITY_MAX_FINDINGS);
}

/** Mức tổng hợp: block > warn > allow. */
export function aggregateV8Level(
  flows: readonly V8TaintFlow[],
  secrets: readonly V8SecretFinding[],
  dependencies: readonly V8DependencyFinding[],
): V8SecurityLevel {
  const levels = [
    ...flows.map((f) => f.level),
    ...secrets.map((s) => s.level),
    ...dependencies.map((d) => d.level),
  ];
  if (levels.includes('block')) return 'block';
  if (levels.includes('warn')) return 'warn';
  return 'allow';
}

/**
 * Quét security v2 cho một thư mục: taint + secret trên mọi file
 * TS/JS/Python (bỏ node_modules/dist/.git), dependency audit từ
 * package.json + package-lock.json ở root (nếu có).
 */
export function scanV8Security(rootDir: string, options: { maxFiles?: number } = {}): V8SecurityReport {
  const maxFiles = options.maxFiles ?? 500;
  const taintFlows: V8TaintFlow[] = [];
  const secrets: V8SecretFinding[] = [];
  let filesScanned = 0;
  const skipDirs = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '__pycache__', '.venv']);
  const walk = (dir: string, rel: string): void => {
    if (filesScanned >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (filesScanned >= maxFiles) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(entry.name)) {
        let content: string;
        try {
          content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        } catch {
          continue;
        }
        filesScanned += 1;
        taintFlows.push(...analyzeV8Taint(content, relPath));
        secrets.push(...scanV8Secrets(content, relPath));
      }
    }
  };
  walk(rootDir, '');
  let packageJson: string | null = null;
  let lockContent: string | null = null;
  try {
    packageJson = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8');
  } catch {
    packageJson = null;
  }
  try {
    lockContent = fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8');
  } catch {
    lockContent = null;
  }
  const dependencies = auditV8Dependencies(packageJson, lockContent);
  const level = aggregateV8Level(taintFlows, secrets, dependencies);
  const summary = level === 'allow'
    ? `clean: ${filesScanned} file(s) scanned`
    : `${level}: ${taintFlows.length} taint flow(s), ${secrets.length} secret(s), ${dependencies.length} vulnerable dep(s) in ${filesScanned} file(s)`;
  return {
    at: new Date().toISOString(),
    filesScanned,
    taintFlows: taintFlows.slice(0, V8_SECURITY_MAX_FINDINGS),
    secrets: secrets.slice(0, V8_SECURITY_MAX_FINDINGS),
    dependencies,
    level,
    summary,
  };
}
