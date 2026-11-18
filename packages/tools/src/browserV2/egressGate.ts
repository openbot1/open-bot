/**
 * Egress allowlist chống page hijack cho browser driver v2
 * (v1.33, Đội T4).
 *
 * Mối đe dọa (survey v133): trang web độc có thể lái agent — nội dung
 * trang (chữ trong trang, form ẩn, redirect, meta refresh) có thể dụ
 * agent navigate ra domain lạ, submit form tới domain lạ, hoặc mở tab
 * mới tới trang lừa đảo. Gate này chạy ở MỖI step, trước khi driver
 * thực thi bất kỳ navigation/form-submit nào:
 *
 *  1. Chỉ domain trong allowlist mới được navigate tới (mặc định: trang
 *     bắt đầu + domain user khai báo; `*` = tắt gate — chỉ dùng cho test
 *     local, phải ghi log cảnh báo).
 *  2. Chặn navigation ra ngoài (kể cả redirect chain: đích cuối cùng
 *     cũng phải qua gate — driver v2 kiểm tra URL sau mỗi lần navigate).
 *  3. Chặn form submit tới domain lạ (origin của action khác allowlist).
 *  4. Log mọi lần chặn (kèm lý do + step) để audit; log mọi lần cho
 *     phép ở mức debug khi bật `logAllowed`.
 *
 * Khớp pattern: exact (`example.com`), wildcard subdomain
 * (`*.example.com` — khớp mọi cấp con, KHÔNG khớp chính `example.com`
 * trừ khi khai báo thêm), suffix (`.example.com`).
 * `data:text/html` luôn được phép (trang test local, không có network);
 * mọi scheme khác ngoài http(s)/data đều bị chặn.
 *
 * Module thuần (không I/O, không DNS) nên test được bằng unit test;
 * SSRF (IP private/loopback) vẫn do `validateNavigateUrl` /
 * `assertPublicUrl` của browser v1 đảm nhiệm — gate này là lớp thứ hai
 * chuyên về allowlist theo domain.
 */

export type EgressGateAction = 'navigate' | 'form-submit' | 'open-link' | 'redirect' | 'resource';

/** Kết quả kiểm tra của gate. */
export interface EgressGateDecision {
  allowed: boolean;
  /** Domain đã kiểm tra (host, lowercase). */
  host: string;
  /** Pattern đã khớp (khi allowed), hoặc null. */
  matchedPattern: string | null;
  /** Lý do chặn/cho phép (đọc được, ghi log). */
  reason: string;
  /** Hành động bị kiểm tra. */
  action: EgressGateAction;
  /** URL đầy đủ đã kiểm tra. */
  url: string;
}

/** Một lần chặn (lưu trong log để audit). */
export interface EgressBlockEntry {
  at: number;
  step: number;
  action: EgressGateAction;
  url: string;
  host: string;
  reason: string;
}

export interface EgressGateOptions {
  /** Domain được phép (vd `['example.com', '*.example.com']`). Rỗng = chỉ data: + trang bắt đầu. */
  allowedHosts?: string[];
  /** URL trang bắt đầu — host của nó luôn được phép (kể cả khi allowlist rỗng). */
  startUrl?: string;
  /** Bật cho phép mọi domain (chỉ dùng cho test local; mọi lần cho phép đều ghi log cảnh báo). */
  allowAll?: boolean;
  /** Ghi log cả lần cho phép (mặc định false — chỉ log lần chặn). */
  logAllowed?: boolean;
  /** Cho phép URL `data:text/html` (mặc định true — trang test local). */
  allowDataUrls?: boolean;
  /** Cho phép localhost/loopback (mặc định false; bật khi automate dev server local). */
  allowLocalhost?: boolean;
  /** Số entry chặn tối đa giữ trong log (mặc định 200). */
  maxBlockLog?: number;
}

/** Chuẩn hoá pattern: lowercase, bỏ port, bỏ dấu `/` thừa. */
export function normalizeHostPattern(pattern: string): string {
  let p = pattern.trim().toLowerCase();
  if (p.startsWith('*.')) return p;
  if (p.startsWith('https://')) p = p.slice('https://'.length);
  if (p.startsWith('http://')) p = p.slice('http://'.length);
  const slash = p.indexOf('/');
  if (slash !== -1) p = p.slice(0, slash);
  const colon = p.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(p.slice(colon + 1))) p = p.slice(0, colon);
  return p;
}

/** true khi host khớp pattern (exact / `*.` / `.suffix`). */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = normalizeHostPattern(pattern);
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // '.example.com'
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  if (p.startsWith('.')) {
    return h.endsWith(p) && h.length > p.length;
  }
  return h === p;
}

/** Host có phải localhost/loopback không. */
export function isLocalhost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h.startsWith('127.') ||
    h === '::1' ||
    h === '[::1]'
  );
}

export class BrowserEgressGate {
  private readonly patterns: string[];
  private readonly allowAll: boolean;
  private readonly logAllowed: boolean;
  private readonly allowDataUrls: boolean;
  private readonly allowLocalhost: boolean;
  private readonly maxBlockLog: number;
  private readonly startHost: string | null;
  private blockLog: EgressBlockEntry[] = [];
  private allowedLog: EgressBlockEntry[] = [];
  private checkCount = 0;
  private blockCount = 0;

  constructor(opts: EgressGateOptions = {}) {
    this.patterns = (opts.allowedHosts ?? []).map(normalizeHostPattern);
    this.allowAll = opts.allowAll ?? false;
    this.logAllowed = opts.logAllowed ?? false;
    this.allowDataUrls = opts.allowDataUrls ?? true;
    this.allowLocalhost = opts.allowLocalhost ?? false;
    this.maxBlockLog = opts.maxBlockLog ?? 200;
    this.startHost = opts.startUrl ? hostOf(opts.startUrl) : null;
    if (this.startHost && !this.patterns.includes(this.startHost)) {
      this.patterns.push(this.startHost);
    }
  }

  /** Danh sách pattern hiện tại (bản sao). */
  get allowedPatterns(): string[] {
    return [...this.patterns];
  }

  /** Thêm domain vào allowlist lúc chạy (vd user phê duyệt thêm domain). */
  addAllowedHost(pattern: string): void {
    const p = normalizeHostPattern(pattern);
    if (!this.patterns.includes(p)) this.patterns.push(p);
  }

  /** Xoá domain khỏi allowlist. */
  removeAllowedHost(pattern: string): void {
    const p = normalizeHostPattern(pattern);
    const idx = this.patterns.indexOf(p);
    if (idx !== -1) this.patterns.splice(idx, 1);
  }

  /** Số lần đã kiểm tra / đã chặn. */
  get counts(): { checks: number; blocked: number } {
    return { checks: this.checkCount, blocked: this.blockCount };
  }

  /** Log các lần chặn (mới nhất cuối). */
  get blocks(): EgressBlockEntry[] {
    return [...this.blockLog];
  }

  /** Log các lần cho phép (chỉ khi `logAllowed` bật). */
  get allowed(): EgressBlockEntry[] {
    return [...this.allowedLog];
  }

  private record(entry: EgressBlockEntry, allowed: boolean): void {
    if (allowed) {
      if (this.logAllowed) {
        this.allowedLog.push(entry);
        if (this.allowedLog.length > this.maxBlockLog) this.allowedLog.shift();
      }
      return;
    }
    this.blockCount += 1;
    this.blockLog.push(entry);
    if (this.blockLog.length > this.maxBlockLog) this.blockLog.shift();
  }

  /**
   * Kiểm tra một URL trước khi thực thi action. `step` là số step hiện
   * tại của driver (ghi log). Không throw — trả về decision; caller
   * chặn khi `allowed === false`.
   */
  check(url: string, action: EgressGateAction, step = 0): EgressGateDecision {
    this.checkCount += 1;
    const at = Date.now();
    const fail = (host: string, reason: string): EgressGateDecision => {
      const decision: EgressGateDecision = { allowed: false, host, matchedPattern: null, reason, action, url };
      this.record({ at, step, action, url, host, reason }, false);
      return decision;
    };
    const pass = (host: string, matched: string | null, reason: string): EgressGateDecision => {
      const decision: EgressGateDecision = { allowed: true, host, matchedPattern: matched, reason, action, url };
      this.record({ at, step, action, url, host, reason }, true);
      return decision;
    };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail('', `Invalid URL: "${url}"`);
    }
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'data:') {
      if (!this.allowDataUrls) return fail('', 'data: URLs are disabled by the egress gate');
      if (!parsed.pathname.startsWith('text/html')) {
        return fail('', `Only data:text/html pages are allowed, got "${parsed.pathname.slice(0, 40)}"`);
      }
      return pass('', null, 'data:text/html local test page');
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      return fail(parsed.hostname, `Unsupported URL scheme "${protocol}" (only http(s) and data:text/html)`);
    }
    const host = parsed.hostname.toLowerCase();
    if (isLocalhost(host)) {
      if (!this.allowLocalhost) {
        return fail(host, 'Localhost/loopback navigation is blocked (enable allowLocalhost for local dev servers)');
      }
      return pass(host, null, 'localhost explicitly allowed');
    }
    if (this.allowAll) {
      return pass(host, '*', 'allowAll enabled (test/local mode — every domain allowed)');
    }
    for (const pattern of this.patterns) {
      if (hostMatchesPattern(host, pattern)) {
        return pass(host, pattern, `Host "${host}" matches allowlist pattern "${pattern}"`);
      }
    }
    return fail(
      host,
      `Host "${host}" is not in the egress allowlist (${this.patterns.length === 0 ? 'empty' : this.patterns.join(', ')})`,
    );
  }

  /**
   * Kiểm tra chuỗi redirect: mọi hop đều phải qua gate. Trả về hop đầu
   * tiên bị chặn (null khi tất cả đều qua).
   */
  checkRedirectChain(urls: string[], step = 0): EgressGateDecision | null {
    for (const url of urls) {
      const decision = this.check(url, 'redirect', step);
      if (!decision.allowed) return decision;
    }
    return null;
  }

  /**
   * Kiểm tra form submit: `formAction` là URL đích của form (có thể
   * tương đối — resolve theo `pageUrl`). Chặn khi đích ra ngoài
   * allowlist, kể cả khi form nằm trên trang hợp lệ (đây chính là kiểu
   * hijack phổ biến: trang độc dụ agent submit credential/form).
   */
  checkFormSubmit(formAction: string, pageUrl: string, step = 0): EgressGateDecision {
    let target: string;
    try {
      target = new URL(formAction, pageUrl).toString();
    } catch {
      return this.check(formAction, 'form-submit', step);
    }
    return this.check(target, 'form-submit', step);
  }
}

/** Host của URL (lowercase), null khi parse lỗi hoặc không có host. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Tạo gate mặc định: chỉ cho phép host của startUrl + data: pages. */
export function createEgressGate(opts: EgressGateOptions = {}): BrowserEgressGate {
  return new BrowserEgressGate(opts);
}
