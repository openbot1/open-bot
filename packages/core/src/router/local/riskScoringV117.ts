/**
 * Risk scoring cho tool call (v1.40, Doi T3) — y tuong tu OpenHands V1 SDK
 * LLMSecurityAnalyzer (chi hoc y tuong, khong copy code/text cua repo nao).
 *
 * Moi tool call duoc cham `SecurityRisk ∈ {LOW, MEDIUM, HIGH, UNKNOWN}`:
 * - Dau vao chinh la MCP tool annotations (`readOnlyHint`,
 *   `destructiveHint`, `idempotentHint`, `openWorldHint`) — tool khong
 *   co annotation va khong nam trong danh sach quen thuoc thi UNKNOWN.
 * - Noi dung call (ten tool + args serialize) duoc quet pattern nguy
 *   hiem: xoa he thong, pipe shell tu mang, doc secret, path traversal,
 *   ghi ra ngoai scope, gui du lieu ra ngoai.
 * - LLM co the tu cham inline qua field `security_risk` trong schema
 *   (khong ton them call): field nay duoc ghi nhan va doi chieu voi
 *   diem he thong tu tinh; he thong luon la chan ly cuoi cung khi
 *   lech nhau.
 *
 * Thuan logic, khong goi model that, khong thuc thi tool.
 */

export type SecurityRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

export const SECURITY_RISKS: readonly SecurityRisk[] = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'];

/** Thu tu rui ro de so sanh nguong (UNKNOWN = fail-closed, nhu HIGH). */
export const SECURITY_RISK_ORDER: Record<SecurityRisk, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  UNKNOWN: 2,
};

export function riskAtLeast(risk: SecurityRisk, threshold: SecurityRisk): boolean {
  return SECURITY_RISK_ORDER[risk] >= SECURITY_RISK_ORDER[threshold];
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface RiskFactor {
  code: string;
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

export type RiskSuggestedAction = 'allow' | 'confirm' | 'block';

export interface ToolCallRisk {
  toolName: string;
  risk: SecurityRisk;
  /** Diem 0..100 (null khi UNKNOWN vi khong du du lieu de cham). */
  score: number | null;
  factors: RiskFactor[];
  /** Gia tri LLM tu cham inline (neu co). */
  inlineRisk?: SecurityRisk;
  /** Inline co khop voi diem he thong khong (false = LLM danh gia thap). */
  inlineAgrees: boolean;
  suggestedAction: RiskSuggestedAction;
  scoredAt: number;
}

export interface RiskScoreRecord extends ToolCallRisk {
  id: string;
  argsSummary: string;
}

interface DangerousPattern {
  code: string;
  severity: 'low' | 'medium' | 'high';
  points: number;
  detail: string;
  test: (haystack: string, toolName: string) => boolean;
}

/** Tool chi doc (theo ten) duoc coi la an toan mac dinh khi chua co annotation. */
const KNOWN_READ_ONLY_TOOLS: readonly string[] = [
  'read', 'get', 'list', 'search', 'show', 'view', 'fetch', 'query', 'describe',
  'cat', 'ls', 'status', 'info', 'lookup', 'find', 'inspect', 'stat', 'head',
  'router_local', 'memory', 'health', 'probe', 'estimate', 'audit', 'log',
];

const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  {
    code: 'shell-delete-system',
    severity: 'high',
    points: 55,
    detail: 'Lenh xoa he thong (rm -rf, mkfs, dd) trong args.',
    test: (h) => /(^|\W)rm\s+-[a-z]*r[a-z]*f\b/.test(h)
      || /\bmkfs\b/.test(h) || /\bdd\s+if=/.test(h) || /\bshutdown\b|\breboot\b/.test(h),
  },
  {
    code: 'shell-pipe-remote',
    severity: 'high',
    points: 50,
    detail: 'Tai script tu mang roi pipe sang shell (curl|sh, wget|bash).',
    test: (h) => /\bcurl\b[^|]*\|\s*(sh|bash)\b/.test(h) || /\bwget\b[^|]*\|\s*(sh|bash)\b/.test(h),
  },
  {
    code: 'shell-privilege',
    severity: 'high',
    points: 35,
    detail: 'Lenh can quyen cao (sudo, su, chmod 777, chown).',
    test: (h) => /\bsudo\b/.test(h) || /\bchmod\s+777\b/.test(h) || /\bchown\b/.test(h),
  },
  {
    code: 'secret-read',
    severity: 'high',
    points: 45,
    detail: 'Doc secret/credential (.env, .ssh, api key, token, password).',
    test: (h, tool) => {
      if (!/read|get|cat|fetch|open|exec|shell|run/i.test(tool)) return false;
      return /\.env\b/.test(h) || /\.ssh\//.test(h) || /id_rsa|id_ed25519/.test(h)
        || /credentials\.json|secrets\.json/.test(h);
    },
  },
  {
    code: 'secret-exfil',
    severity: 'high',
    points: 40,
    detail: 'Args chua secret (password/token/api_key) co the bi gui di.',
    test: (h) => /"(password|passwd|api[_-]?key|secret|access[_-]?token|bearer)"\s*:\s*".{4,}"/.test(h),
  },
  {
    code: 'path-traversal',
    severity: 'medium',
    points: 25,
    detail: 'Path traversal (..) hoac duong dan he thong (/etc, /root).',
    test: (h) => /\.\.[/\\]/.test(h) || /\/etc\/|\/root\/|C:\\Windows\\/i.test(h),
  },
  {
    code: 'delete-operation',
    severity: 'medium',
    points: 25,
    detail: 'Thao tac xoa (delete/remove/drop/truncate) theo ten tool hoac args.',
    test: (h, tool) => /delete|remove|drop|truncate|destroy|purge/i.test(tool)
      || /"(op|operation|action)"\s*:\s*"(delete|remove|drop)"/.test(h),
  },
  {
    code: 'external-network',
    severity: 'medium',
    points: 20,
    detail: 'Gui du lieu ra URL ngoai (http/https khong phai loopback).',
    test: (h) => /https?:\/\/(?!127\.0\.0\.1|localhost)[\w.-]+/.test(h),
  },
  {
    code: 'write-outside-scope',
    severity: 'medium',
    points: 20,
    detail: 'Ghi file ra ngoai workspace (duong dan tuyet doi /tmp he thong, $HOME).',
    test: (h) => /\$HOME|\/tmp\/|\/var\//.test(h) && /(write|save|create|put)/i.test(h),
  },
  {
    code: 'exec-code',
    severity: 'medium',
    points: 25,
    detail: 'Thuc thi code/lenh shell (exec/run/bash/python).',
    test: (h, tool) => /exec|shell|bash|run_command|run_code/i.test(tool),
  },
  {
    code: 'bulk-mutation',
    severity: 'low',
    points: 10,
    detail: 'Thao tac ghi/sua so luong lon (bulk, all, *).',
    test: (h) => /"(all|bulk|every)"\s*:\s*true/.test(h) || /\*\s*$/.test(h),
  },
];

function riskFromScore(score: number): SecurityRisk {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

function suggestedActionFor(risk: SecurityRisk): RiskSuggestedAction {
  if (risk === 'HIGH' || risk === 'UNKNOWN') return 'confirm';
  if (risk === 'MEDIUM') return 'confirm';
  return 'allow';
}

/**
 * Parse field `security_risk` LLM tu cham inline trong schema.
 * Tra null khi field khong co / khong hop le (khong throw).
 */
export function parseInlineSecurityRisk(value: unknown): SecurityRisk | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if ((SECURITY_RISKS as readonly string[]).includes(upper)) return upper as SecurityRisk;
  return null;
}

export interface ScoreToolCallOptions {
  /** Diem san co neu tool khong co annotation va khong co pattern. */
  defaultScore?: number;
}

/**
 * Cham rui ro cho mot tool call (thuan, khong co side-effect).
 * `annotations` undefined = tool chua dang ky annotation.
 */
export function scoreToolCallRisk(
  toolName: string,
  annotations: ToolAnnotations | undefined,
  args: unknown,
  opts: ScoreToolCallOptions = {},
): ToolCallRisk {
  const name = typeof toolName === 'string' && toolName.trim() !== '' ? toolName : 'unknown-tool';
  const factors: RiskFactor[] = [];
  let score = 0;

  const argsText = args === undefined || args === null ? '' : JSON.stringify(args);
  const haystack = `${name} ${argsText}`.toLowerCase();
  const argsForInline = (args !== null && typeof args === 'object' && !Array.isArray(args))
    ? args as Record<string, unknown>
    : {};
  const inlineRisk = parseInlineSecurityRisk(argsForInline.security_risk);

  const knownReadOnly = KNOWN_READ_ONLY_TOOLS.some(
    (prefix) => name.toLowerCase().includes(prefix),
  );

  if (annotations === undefined) {
    if (knownReadOnly) {
      factors.push({
        code: 'known-read-only-name',
        severity: 'low',
        detail: `Tool "${name}" chua co annotation nhung ten goi y chi doc.`,
      });
      score += 5;
    } else {
      // Khong du du lieu: UNKNOWN (fail-closed), tru khi pattern nguy
      // hiem bat duoc thi nang len HIGH ben duoi.
      factors.push({
        code: 'unknown-tool',
        severity: 'high',
        detail: `Tool "${name}" chua dang ky annotation — khong du du lieu de cham.`,
      });
    }
  } else {
    if (annotations.destructiveHint === true) {
      score += 55;
      factors.push({ code: 'destructive-hint', severity: 'high', detail: 'Annotation destructiveHint=true.' });
    }
    if (annotations.readOnlyHint === true) {
      score = Math.max(0, score - 10);
      factors.push({ code: 'read-only-hint', severity: 'low', detail: 'Annotation readOnlyHint=true.' });
    } else if (annotations.readOnlyHint === false) {
      score += 15;
      factors.push({ code: 'write-hint', severity: 'medium', detail: 'Annotation readOnlyHint=false (tool ghi/sua).' });
    }
    if (annotations.openWorldHint === true) {
      score += 10;
      factors.push({ code: 'open-world-hint', severity: 'medium', detail: 'Annotation openWorldHint=true (tuong tac the gioi ben ngoai).' });
    }
    if (annotations.idempotentHint === true) {
      score = Math.max(0, score - 5);
      factors.push({ code: 'idempotent-hint', severity: 'low', detail: 'Annotation idempotentHint=true (goi lai an toan).' });
    }
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(haystack, name)) {
      score += pattern.points;
      factors.push({ code: pattern.code, severity: pattern.severity, detail: pattern.detail });
    }
  }

  const hasDangerousPattern = factors.some((f) => f.severity === 'high' && f.code !== 'unknown-tool');
  const isUnknown = annotations === undefined && !knownReadOnly && !hasDangerousPattern;

  let risk: SecurityRisk;
  let finalScore: number | null;
  if (isUnknown) {
    risk = 'UNKNOWN';
    finalScore = null;
  } else {
    finalScore = Math.min(100, Math.max(0, score));
    risk = riskFromScore(finalScore);
    if (hasDangerousPattern && risk === 'LOW') risk = 'MEDIUM';
  }

  let inlineAgrees = true;
  if (inlineRisk !== null) {
    inlineAgrees = inlineRisk === risk
      || (inlineRisk === 'HIGH' && risk === 'HIGH')
      || (inlineRisk === 'UNKNOWN' && risk === 'UNKNOWN');
    if (!inlineAgrees && SECURITY_RISK_ORDER[inlineRisk] < SECURITY_RISK_ORDER[risk]) {
      factors.push({
        code: 'inline-underestimates',
        severity: 'medium',
        detail: `LLM tu cham inline "${inlineRisk}" thap hon diem he thong "${risk}" — lay diem he thong.`,
      });
    }
  }

  return {
    toolName: name,
    risk,
    score: finalScore,
    factors,
    inlineRisk: inlineRisk ?? undefined,
    inlineAgrees,
    suggestedAction: suggestedActionFor(risk),
    scoredAt: Date.now(),
  };
}

let riskRecordCounter = 0;

/**
 * Catalog annotation mac dinh cho cac tool pho bien (theo MCP
 * annotation semantics). RiskScorer tu seed catalog nay luc khoi tao
 * (tat duoc qua `{ seedBuiltin: false }`) de tool quen thuoc khong
 * bi cham UNKNOWN chi vi host chua dang ky tay. Catalog la y kien
 * bao thu: tool nao co the ghi/xoa deu danh dau readOnlyHint=false;
 * chi tool chac chan chi doc moi duoc readOnlyHint=true.
 */
export const BUILTIN_TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  file_read: { readOnlyHint: true, idempotentHint: true },
  file_list: { readOnlyHint: true, idempotentHint: true },
  directory_list: { readOnlyHint: true, idempotentHint: true },
  file_write: { readOnlyHint: false, idempotentHint: true },
  file_delete: { readOnlyHint: false, destructiveHint: true },
  file_move: { readOnlyHint: false },
  file_rename: { readOnlyHint: false },
  shell_exec: { readOnlyHint: false },
  run_command: { readOnlyHint: false },
  http_get: { readOnlyHint: true, openWorldHint: true },
  http_post: { readOnlyHint: false, openWorldHint: true },
  git_status: { readOnlyHint: true, idempotentHint: true },
  git_log: { readOnlyHint: true, idempotentHint: true },
  git_diff: { readOnlyHint: true, idempotentHint: true },
  git_commit: { readOnlyHint: false },
  git_push: { readOnlyHint: false, openWorldHint: true },
  db_query: { readOnlyHint: true },
  db_execute: { readOnlyHint: false },
  send_email: { readOnlyHint: false, openWorldHint: true },
  send_message: { readOnlyHint: false, openWorldHint: true },
  browser_navigate: { readOnlyHint: true, openWorldHint: true },
  memory_search: { readOnlyHint: true, idempotentHint: true },
};

/** Tra annotation builtin cho mot tool (undefined neu khong co). */
export function builtinAnnotationsFor(toolName: string): ToolAnnotations | undefined {
  const found = BUILTIN_TOOL_ANNOTATIONS[toolName];
  return found ? { ...found } : undefined;
}

/**
 * RiskScorer — registry annotation + lich su cham diem.
 * Host dang ky annotation cho tung tool (thuong lay tu MCP server
 * hoac khai bao tay); tool chua dang ky thi cham UNKNOWN.
 */
export class RiskScorer {
  private readonly annotations = new Map<string, ToolAnnotations>();
  private readonly history: RiskScoreRecord[] = [];
  private readonly historyCapacity: number;
  private readonly seededBuiltin: boolean;

  constructor(historyCapacity = 200, opts: { seedBuiltin?: boolean } = {}) {
    this.historyCapacity = Math.max(1, historyCapacity);
    this.seededBuiltin = opts.seedBuiltin !== false;
    if (this.seededBuiltin) {
      for (const [toolName, annotations] of Object.entries(BUILTIN_TOOL_ANNOTATIONS)) {
        this.annotations.set(toolName, { ...annotations });
      }
    }
  }

  isBuiltinSeeded(): boolean {
    return this.seededBuiltin;
  }

  /** Danh sach tool co annotation builtin trong catalog. */
  catalogTools(): string[] {
    return Object.keys(BUILTIN_TOOL_ANNOTATIONS).sort();
  }

  registerAnnotations(toolName: string, annotations: ToolAnnotations): ToolAnnotations {
    if (typeof toolName !== 'string' || toolName.trim() === '') {
      throw new Error('toolName phai la string khong rong.');
    }
    const clean: ToolAnnotations = {};
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      if (annotations[key] !== undefined) {
        if (typeof annotations[key] !== 'boolean') {
          throw new Error(`Annotation "${key}" phai la boolean.`);
        }
        clean[key] = annotations[key];
      }
    }
    this.annotations.set(toolName, clean);
    return { ...clean };
  }

  getAnnotations(toolName: string): ToolAnnotations | undefined {
    const found = this.annotations.get(toolName);
    return found ? { ...found } : undefined;
  }

  registeredTools(): string[] {
    return [...this.annotations.keys()].sort();
  }

  unregister(toolName: string): boolean {
    return this.annotations.delete(toolName);
  }

  /** Cham + ghi lich su. Tra ban ghi co id de audit sau nay. */
  score(toolName: string, args: unknown, opts: ScoreToolCallOptions = {}): RiskScoreRecord {
    const result = scoreToolCallRisk(toolName, this.annotations.get(toolName), args, opts);
    const record: RiskScoreRecord = {
      ...result,
      id: `risk-${++riskRecordCounter}`,
      argsSummary: args === undefined || args === null
        ? '(no args)'
        : JSON.stringify(args).slice(0, 240),
    };
    this.history.push(record);
    if (this.history.length > this.historyCapacity) {
      this.history.splice(0, this.history.length - this.historyCapacity);
    }
    return record;
  }

  getHistory(): RiskScoreRecord[] {
    return [...this.history].reverse();
  }

  getRecord(id: string): RiskScoreRecord | undefined {
    return this.history.find((r) => r.id === id);
  }

  clearHistory(): void {
    this.history.length = 0;
  }
}
