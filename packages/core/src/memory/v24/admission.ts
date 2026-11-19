/**
 * Memory v24 — admission policy (v1.39, Doi T1).
 *
 * Y tuong R083 building blocks (chi y tuong): admission policy —
 * cai gi duoc ghi vao memory; scope + expiry gan ngay luc ghi;
 * memory poisoning — chong memory doc (prompt injection, secret,
 * PII, spam) ngay luc admission, noi tiep memory v18 (mo rong
 * sang admission-time).
 *
 * Tu thiet ke lai hoan toan cho open-bot, chay local, rule-based
 * (khong goi model):
 *  - screen(text, meta) -> V24AdmissionDecision: allow /
 *    quarantine / deny + riskScore + rule da kich hoat + scope +
 *    expiry + kind duoc gan.
 *  - Deny: credential-like (khoa API, password, private key),
 *    instruction-injection ("ignore previous instructions",
 *    "you are now", "system prompt"), qua dai.
 *  - Quarantine: PII (email, so dien thoai, so the), URL spam,
 *    lap lai bat thuong, noi dung khong phai ngon ngu (garbage).
 *  - Allow: confidence thap van allow neu risk thap (retrieval
 *    se tu phan xu sau, theo tinh than ADD-only).
 *  - Expiry: tinh tu scope level (run 7 ngay, agent/user/app
 *    mac dinh 180/365 ngay) — co the override.
 *  - Admission log: chi luu preview cat ngan (khong luu secret),
 *    dem theo verdict de stats/health.
 */
import {
  isoAtV24,
  makeV24Id,
  truncateV24,
  clamp01V24,
  scopeLevelV24,
  type V24AdmissionDecision,
  type V24AdmissionLogEntry,
  type V24AdmissionPolicyConfig,
  type V24RecordKind,
  type V24Scope,
  V24_ADMISSION_POLICY_VERSION,
  V24_DEFAULT_ADMISSION_CONFIG,
  V24_MAX_TEXT_CHARS,
} from './types';

/** Pattern credential-like (chi regex, khong luu gia tri that). */
const CREDENTIAL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'api-key-prefix', re: /\b(sk-[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/ },
  { name: 'password-assign', re: /\b(password|passwd|pwd)\s*[:=]\s*\S{4,}/i },
  { name: 'private-key-block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}/ },
  { name: 'secret-assign', re: /\b(api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9\-_]{16,}["']?/i },
];

/** Pattern instruction-injection (tieng Anh + tieng Viet). */
const INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'ignore-instructions', re: /ignore (all )?(previous|prior|above) instructions/i },
  { name: 'you-are-now', re: /you are now (a|an|the|in)\b/i },
  { name: 'system-prompt-leak', re: /(reveal|show|print|output) (your |the )?(system prompt|instructions|hidden prompt)/i },
  { name: 'jailbreak-role', re: /\b(DAN|jailbreak|developer mode)\b.{0,40}(enabled|activated|on)/i },
  { name: 'override-policy', re: /(disregard|override|bypass) (all )?(safety|policy|rules|filters)/i },
  { name: 'bo-qua-chi-dan', re: /bỏ qua (mọi |tất cả )?(chỉ dẫn|hướng dẫn|lệnh) (trước|phía trên)/i },
  { name: 'dong-vai-moi', re: /từ giờ (hãy |bạn )?(đóng vai|là) /i },
];

/** Pattern PII (chi phat hien su hien dien, khong trich gia tri). */
const PII_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: 'phone-vn', re: /(?<!\d)(0\d{9}|\+84\d{9})(?!\d)/ },
  { name: 'credit-card', re: /(?<!\d)(?:\d[ -]?){13,16}\d(?!\d)/ },
  { name: 'cccd-vn', re: /(?<!\d)\d{9}(?!\d)|\b\d{12}\b/ },
];

/** Pattern URL (de dem spam). */
const URL_RE = /https?:\/\/[^\s/$.?#].[^\s]*/gi;

/** Kiem tra text co lap lai bat thuong khong (cung tu lap > 60%). */
export function repetitionRatioV24(text: string): number {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9à-ỹ]+/u)
    .filter((w) => w.length > 1);
  if (words.length < 10) return 0;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let max = 0;
  for (const c of counts.values()) max = Math.max(max, c);
  return max / words.length;
}

/** Kiem tra text co phai garbage (ti le ky tu la thap) khong. */
export function garbageRatioV24(text: string): number {
  if (text.length === 0) return 0;
  let weird = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 0x00c0 && code <= 0x024f) || (code >= 0x1e00 && code <= 0x1eff) ||
      (code >= 0x3040 && code <= 0x30ff) || (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3);
    const isDigit = code >= 48 && code <= 57;
    const isSpace = /\s/.test(ch);
    const isPunct = /[.,;:!?'"()\[\]{}<>\/\\\-_=+*&%$#@~`|]/.test(ch);
    if (!isLetter && !isDigit && !isSpace && !isPunct) weird++;
  }
  return weird / text.length;
}

/** Input cho admission screening. */
export interface V24AdmissionInput {
  text: string;
  /** Kind goi y (neu khong co thi suy ra tu scope). */
  kind?: V24RecordKind;
  scope: V24Scope;
  /** Confidence cua extractor (neu co). */
  confidence?: number;
  /** Thoi diem screening (ms). */
  nowMs?: number;
  /** Expiry override (ISO, null = tinh theo policy). */
  expiresAt?: string | null;
}

/** Admission policy: screen + log + stats. */
export class V24AdmissionPolicy {
  readonly config: V24AdmissionPolicyConfig;
  private log: V24AdmissionLogEntry[] = [];
  private readonly now: () => number;

  constructor(config: Partial<V24AdmissionPolicyConfig> = {}, opts: { now?: () => number } = {}) {
    this.config = {
      ...V24_DEFAULT_ADMISSION_CONFIG,
      ...config,
      ttlByScopeLevel: {
        ...V24_DEFAULT_ADMISSION_CONFIG.ttlByScopeLevel,
        ...(config.ttlByScopeLevel ?? {}),
      },
    };
    this.now = opts.now ?? Date.now;
  }

  /** Tinh expiry tu scope level (null = khong het han). */
  computeExpiry(scope: V24Scope, nowMs?: number): string | null {
    const level = scopeLevelV24(scope);
    const ttl = this.config.ttlByScopeLevel[level];
    if (ttl === null || ttl === undefined) return null;
    return isoAtV24((nowMs ?? this.now()) + ttl);
  }

  /** Screen 1 text: tra quyet dinh + ghi log. */
  screen(input: V24AdmissionInput): V24AdmissionDecision {
    const nowMs = input.nowMs ?? this.now();
    const text = input.text ?? '';
    const reasons: string[] = [];
    const triggered: string[] = [];
    let risk = 0;

    if (!text.trim()) {
      const d = this.decide('deny', ['Text rong, khong co gi de ghi.'], 1, ['empty'], input, nowMs);
      this.log.push({ ...d, sourcePreview: '' });
      return d;
    }
    if (text.length > this.config.maxChars) {
      reasons.push(`Text dai ${text.length} ky tu, vuot gioi han ${this.config.maxChars}.`);
      triggered.push('too-long');
      risk = Math.max(risk, 0.9);
    }

    if (this.config.blockCredentials) {
      for (const p of CREDENTIAL_PATTERNS) {
        if (p.re.test(text)) {
          reasons.push(`Phat hien mau credential (${p.name}) — khong ghi secret vao memory.`);
          triggered.push(`credential:${p.name}`);
          risk = Math.max(risk, 0.95);
          break;
        }
      }
    }
    if (this.config.blockInjection) {
      for (const p of INJECTION_PATTERNS) {
        if (p.re.test(text)) {
          reasons.push(`Phat hien instruction-injection (${p.name}) — co dau hieu memory poisoning.`);
          triggered.push(`injection:${p.name}`);
          risk = Math.max(risk, 0.95);
          break;
        }
      }
    }

    let piiFound = false;
    if (this.config.blockPII) {
      for (const p of PII_PATTERNS) {
        if (p.re.test(text)) {
          reasons.push(`Phat hien PII (${p.name}) — can cach ly truoc khi ghi.`);
          triggered.push(`pii:${p.name}`);
          risk = Math.max(risk, 0.6);
          piiFound = true;
          break;
        }
      }
    }

    const urls = text.match(URL_RE) ?? [];
    if (urls.length >= 5) {
      reasons.push(`Chua ${urls.length} URL — dau hieu spam.`);
      triggered.push('url-spam');
      risk = Math.max(risk, 0.55);
    }
    const rep = repetitionRatioV24(text);
    if (rep > 0.6) {
      reasons.push(`Lap tu bat thuong (${Math.round(rep * 100)}% cung 1 tu) — dau hieu spam.`);
      triggered.push('repetition');
      risk = Math.max(risk, 0.55);
    }
    const garbage = garbageRatioV24(text);
    if (garbage > 0.3) {
      reasons.push(`Ti le ky tu la cao (${Math.round(garbage * 100)}%) — noi dung khong doc duoc.`);
      triggered.push('garbage');
      risk = Math.max(risk, 0.6);
    }
    void piiFound;

    const confidence = input.confidence ?? 0.5;
    if (confidence < this.config.minConfidence) {
      reasons.push(`Confidence ${confidence} duoi nguong ${this.config.minConfidence}.`);
      triggered.push('low-confidence');
      risk = Math.max(risk, 0.4);
    }

    let verdict: V24AdmissionDecision['verdict'] = 'allow';
    if (risk >= this.config.denyRiskThreshold) verdict = 'deny';
    else if (risk >= this.config.quarantineRiskThreshold) verdict = 'quarantine';
    if (verdict === 'allow' && reasons.length === 0) {
      reasons.push('Dat admission: khong phat hien rui ro.');
    }

    const decision = this.decide(verdict, reasons, clamp01V24(risk), triggered, input, nowMs);
    this.log.push({ ...decision, sourcePreview: truncateV24(text, 200) });
    return decision;
  }

  private decide(
    verdict: V24AdmissionDecision['verdict'],
    reasons: string[],
    riskScore: number,
    triggeredRules: string[],
    input: V24AdmissionInput,
    nowMs: number,
  ): V24AdmissionDecision {
    const expiresAt = input.expiresAt !== undefined
      ? input.expiresAt
      : this.computeExpiry(input.scope, nowMs);
    return {
      id: makeV24Id('adm'),
      verdict,
      reasons,
      riskScore,
      triggeredRules,
      scope: { ...input.scope },
      expiresAt,
      kind: input.kind ?? 'fact',
      screenedAt: isoAtV24(nowMs),
      policyVersion: V24_ADMISSION_POLICY_VERSION,
      sourceChars: input.text.length,
    };
  }

  /** Admission log (moi nhat truoc), loc theo verdict. */
  listLog(opts: { verdict?: V24AdmissionDecision['verdict']; limit?: number } = {}): V24AdmissionLogEntry[] {
    const out = [...this.log].reverse().filter((e) => !opts.verdict || e.verdict === opts.verdict);
    return opts.limit !== undefined ? out.slice(0, Math.max(0, opts.limit)) : out;
  }

  /** Dem theo verdict. */
  counts(): { allow: number; quarantine: number; deny: number } {
    const c = { allow: 0, quarantine: 0, deny: 0 };
    for (const e of this.log) c[e.verdict]++;
    return c;
  }

  /** Xoa log (chi dung khi reset store). */
  clearLog(): void {
    this.log = [];
  }
}

/** Screen nhanh khong can policy instance (dung config mac dinh). */
export function screenTextV24(input: V24AdmissionInput): V24AdmissionDecision {
  return new V24AdmissionPolicy().screen(input);
}

/** Kiem tra 1 text co chua credential khong (khong luu gia tri). */
export function containsCredentialV24(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => p.re.test(text));
}

/** Kiem tra 1 text co dau hieu injection khong. */
export function containsInjectionV24(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.re.test(text));
}

/** Kiem tra 1 text co PII khong. */
export function containsPIIV24(text: string): boolean {
  return PII_PATTERNS.some((p) => p.re.test(text));
}
