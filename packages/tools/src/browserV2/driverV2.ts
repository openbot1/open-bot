/**
 * Browser driver v2 — a11y-tree làm perception chính, vision fallback
 * khi element không có trong tree, egress gate ở mỗi step
 * (v1.33, Đội T4).
 *
 * Nối vào driver v1 (`browserAutomation.ts`) thay vì viết hệ song song:
 *  - Tái dùng `BrowserPageDriver` / `validateNavigateUrl` / timeout và
 *    quy ước session của v1 (lazy launch, idle close, fake launcher
 *    cho test).
 *  - Mở rộng page driver thêm `ariaSnapshot()` (Playwright
 *    `page.locator('body').ariaSnapshot({ mode: 'ai' })` — CHỈ mode
 *    `'ai'` mới kèm `[ref=eN]`; mode mặc định KHÔNG có ref nên
 *    clickRef/fillRef sẽ không resolve được. Đã kiểm chứng bằng
 *    Chromium thật 2026-11-17: mode default không ref, mode ai có
 *    ref e1..eN và selector `aria-ref=eN` resolve được), `clickRef()` /
 *    `fillRef()` (resolve ref bằng selector engine `aria-ref=` của
 *    Playwright — đã kiểm chứng có trong playwright-core 1.65),
 *    `clickAt()` (mouse) và `viewportSize()`.
 *  - Mỗi step đều qua `BrowserEgressGate` (navigate / redirect /
 *    form-submit) rồi mới thực thi; step log ghi lại action, ref/tọa
 *    độ, có qua vision fallback không, và lần chặn nào.
 *  - Snapshot sau mỗi step đi qua `SnapshotCache`: model chỉ nhận diff.
 *
 * Khi không có browser thật (test / CI không có Chromium): dùng fake
 * launcher (`createFakeBrowserV2Driver` trong file test helper, hoặc
 * bất kỳ `BrowserV2Launcher` nào caller inject) — mọi logic gate/cache/
 * diff đều chạy y hệt.
 */
import { chromium } from 'playwright';
import type { ToolContext } from '@open-bot/core';
import {
  validateNavigateUrl,
  type BrowserPageDriver,
} from '../browserAutomation';
import {
  findNodeByRef,
  type A11yNode,
} from './a11ySnapshot';
import { BrowserEgressGate, type EgressGateDecision, type EgressGateOptions } from './egressGate';
import { SnapshotCache, type SnapshotCacheOptions, type SnapshotPayload } from './snapshotCache';
import { VisionFallback, type ElementBox, type VisionFallbackOptions } from './visionFallback';

export type { EgressGateDecision };

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_CLOSE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Driver v2 (mở rộng page driver v1)
// ---------------------------------------------------------------------------

/** Page driver v2: v1 + aria snapshot + click/fill theo ref + click tọa độ. */
export interface BrowserV2PageDriver extends BrowserPageDriver {
  /** Aria snapshot thô của body (định dạng Playwright). */
  ariaSnapshot(opts?: { timeout?: number }): Promise<string>;
  /** Click element theo ref trong snapshot (`aria-ref=`). */
  clickRef(ref: string, opts?: { timeout?: number }): Promise<void>;
  /** Điền text vào element theo ref (textbox/searchbox/...). */
  fillRef(ref: string, text: string, opts?: { timeout?: number }): Promise<void>;
  /** Click chuột tại tọa độ viewport (vision fallback). */
  clickAt(x: number, y: number, opts?: { timeout?: number }): Promise<void>;
  /** Quay lại trang trước (history back). */
  goBack(opts?: { timeout?: number }): Promise<void>;
  /** Kích thước viewport hiện tại (null khi driver không biết). */
  viewportSize(): Promise<{ width: number; height: number } | null>;
  /** Bounding box của element theo ref (null khi không đo được). */
  boundingBoxOfRef?(ref: string): Promise<ElementBox | null>;
}

/** Browser driver v2 (tạo page v2). */
export interface BrowserDriverV2 {
  newPage(): Promise<BrowserV2PageDriver>;
  close(): Promise<void>;
}

export type BrowserV2Launcher = (opts: { headless: boolean }) => Promise<BrowserDriverV2>;

/** Launcher Playwright thật (headless Chromium). */
export async function launchPlaywrightBrowserV2(opts: {
  headless: boolean;
}): Promise<BrowserDriverV2> {
  let browser;
  try {
    const launchArgs =
      typeof process.getuid === 'function' && process.getuid() === 0
        ? ['--no-sandbox']
        : [];
    browser = await chromium.launch({ headless: opts.headless, args: launchArgs });
  } catch (err) {
    throw new Error(
      `Failed to launch Chromium via Playwright: ${(err as Error).message} ` +
        `(Is a Chromium build installed? Run \`npx playwright install chromium\`.)`,
    );
  }
  return {
    async newPage(): Promise<BrowserV2PageDriver> {
      const page = await browser.newPage();
      const base: BrowserPageDriver = {
        url: () => page.url(),
        title: () => page.title(),
        goto: (url, gotoOpts) =>
          page.goto(url, { timeout: gotoOpts?.timeout, waitUntil: 'domcontentloaded' }).then(() => undefined),
        click: (selector, clickOpts) =>
          page.locator(selector).first().click({ timeout: clickOpts?.timeout }).then(() => undefined),
        fill: (selector, text, fillOpts) =>
          page.locator(selector).first().fill(text, { timeout: fillOpts?.timeout }).then(() => undefined),
        screenshot: (shotOpts) => page.screenshot({ path: shotOpts?.path, fullPage: shotOpts?.fullPage }),
        innerText: (selector, textOpts) =>
          selector
            ? page.locator(selector).first().innerText({ timeout: textOpts?.timeout })
            : page.locator('body').innerText({ timeout: textOpts?.timeout }),
        close: () => page.close().catch(() => undefined),
      };
      return {
        ...base,
        ariaSnapshot: (snapOpts) =>
          // mode 'ai' bắt buộc: chỉ mode này Playwright mới kèm [ref=eN]
          // (mode default không có ref — clickRef sẽ không resolve được).
          page.locator('body').ariaSnapshot({ timeout: snapOpts?.timeout, mode: 'ai' }),
        clickRef: (ref, refOpts) =>
          page.locator(`aria-ref=${ref}`).click({ timeout: refOpts?.timeout }).then(() => undefined),
        fillRef: (ref, text, refOpts) =>
          page.locator(`aria-ref=${ref}`).fill(text, { timeout: refOpts?.timeout }).then(() => undefined),
        clickAt: (x, y) => page.mouse.click(x, y).then(() => undefined),
        goBack: (backOpts) =>
          page.goBack({ timeout: backOpts?.timeout, waitUntil: 'domcontentloaded' }).then(() => undefined),
        viewportSize: () => Promise.resolve(page.viewportSize()),
        boundingBoxOfRef: async (ref) => {
          const box = await page.locator(`aria-ref=${ref}`).boundingBox();
          return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
        },
      };
    },
    close: () => browser.close().catch(() => undefined),
  };
}

// ---------------------------------------------------------------------------
// Session v2
// ---------------------------------------------------------------------------

export interface BrowserV2Options {
  defaultNavigationTimeoutMs?: number;
  defaultActionTimeoutMs?: number;
  idleCloseMs?: number;
  /** Cho phép http(s) tới loopback/private (mặc định false — SSRF guard). */
  allowLocalUrls?: boolean;
  /** DNS resolver cho SSRF check (test inject fake). */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** Override launcher (test inject fake; mặc định Playwright thật). */
  createBrowser?: BrowserV2Launcher;
  /** Cấu hình egress gate (allowlist domain). */
  egress?: EgressGateOptions;
  /** Cấu hình snapshot cache (diff threshold...). */
  snapshotCache?: SnapshotCacheOptions;
  /** Cấu hình vision fallback (viewport...). */
  vision?: VisionFallbackOptions;
  /** Workspace dir (dùng chung quy ước v1; hiện chỉ để dành cho screenshot sau này). */
  workspaceDir?: string;
}

/** Một step đã thực thi (audit + eval). */
export interface BrowserV2StepRecord {
  step: number;
  action: string;
  ok: boolean;
  /** Chi tiết ngắn (ref / URL / tọa độ / lỗi). */
  detail: string;
  /** Step này có dùng vision fallback (click tọa độ) không. */
  viaVision: boolean;
  /** Step này có bị egress gate chặn không. */
  blocked: boolean;
  at: number;
}

interface SessionState {
  driver: BrowserDriverV2 | null;
  page: BrowserV2PageDriver | null;
  idleTimer: NodeJS.Timeout | null;
  closing: Promise<void> | null;
}

async function closeSessionState(state: SessionState): Promise<void> {
  if (state.closing) return state.closing;
  state.closing = (async () => {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    const page = state.page;
    const driver = state.driver;
    state.page = null;
    state.driver = null;
    if (page) await page.close().catch(() => undefined);
    if (driver) await driver.close().catch(() => undefined);
  })();
  try {
    await state.closing;
  } finally {
    state.closing = null;
  }
}

function armIdleTimer(state: SessionState, idleCloseMs: number): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
  if (idleCloseMs <= 0) return;
  state.idleTimer = setTimeout(() => {
    void closeSessionState(state).catch(() => undefined);
  }, idleCloseMs);
  if (typeof state.idleTimer.unref === 'function') state.idleTimer.unref();
}

/** Kết quả snapshot trả về cho model/tool. */
export interface BrowserV2SnapshotResult {
  step: number;
  url: string;
  payload: SnapshotPayload;
  nodes: A11yNode[];
  nodeCount: number;
}

export class BrowserV2Session {
  readonly gate: BrowserEgressGate;
  readonly cache: SnapshotCache;
  readonly vision: VisionFallback;
  private readonly opts: Required<
    Omit<BrowserV2Options, 'createBrowser' | 'allowLocalUrls' | 'lookupFn' | 'egress' | 'snapshotCache' | 'vision' | 'workspaceDir'>
  > &
    Pick<BrowserV2Options, 'createBrowser' | 'allowLocalUrls' | 'lookupFn' | 'workspaceDir'>;
  private readonly state: SessionState = { driver: null, page: null, idleTimer: null, closing: null };
  private stepCounter = 0;
  private stepLog: BrowserV2StepRecord[] = [];
  private currentUrl = '';

  constructor(opts: BrowserV2Options = {}) {
    this.opts = {
      defaultNavigationTimeoutMs: opts.defaultNavigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      defaultActionTimeoutMs: opts.defaultActionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      idleCloseMs: opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS,
      createBrowser: opts.createBrowser,
      allowLocalUrls: opts.allowLocalUrls,
      lookupFn: opts.lookupFn,
      workspaceDir: opts.workspaceDir,
    };
    this.gate = new BrowserEgressGate(opts.egress ?? {});
    this.cache = new SnapshotCache(opts.snapshotCache ?? {});
    this.vision = new VisionFallback(opts.vision ?? {});
  }

  /** True khi browser đang mở. */
  isOpen(): boolean {
    return this.state.page !== null;
  }

  /** URL hiện tại ('' khi chưa navigate). */
  get url(): string {
    return this.currentUrl;
  }

  /** Số step đã thực thi. */
  get steps(): number {
    return this.stepCounter;
  }

  /** Log các step (bản sao). */
  get stepsLog(): BrowserV2StepRecord[] {
    return [...this.stepLog];
  }

  /** Đóng browser ngay (no-op khi đã đóng). */
  async close(): Promise<void> {
    await closeSessionState(this.state);
  }

  private recordStep(action: string, detail: string, ok: boolean, viaVision = false, blocked = false): BrowserV2StepRecord {
    const rec: BrowserV2StepRecord = {
      step: this.stepCounter,
      action,
      ok,
      detail,
      viaVision,
      blocked,
      at: Date.now(),
    };
    this.stepCounter += 1;
    this.stepLog.push(rec);
    return rec;
  }

  private async ensurePage(signal?: AbortSignal): Promise<BrowserV2PageDriver> {
    if (signal?.aborted) throw new Error('Operation aborted before it started.');
    if (this.state.page) {
      armIdleTimer(this.state, this.opts.idleCloseMs);
      return this.state.page;
    }
    const launcher = this.opts.createBrowser ?? launchPlaywrightBrowserV2;
    const driver = await launcher({ headless: true });
    this.state.driver = driver;
    try {
      this.state.page = await driver.newPage();
    } catch (err) {
      await closeSessionState(this.state).catch(() => undefined);
      throw new Error(`Failed to open a browser page: ${(err as Error).message}`);
    }
    const viewport = await this.state.page.viewportSize().catch(() => null);
    if (viewport) this.vision.setViewport(viewport);
    armIdleTimer(this.state, this.opts.idleCloseMs);
    return this.state.page;
  }

  /**
   * Navigate (gate trước, SSRF sau, verify đích cuối sau navigate).
   * Trả về URL cuối cùng (sau redirect) — nếu đích cuối bị gate chặn
   * thì throw (trang đã load nhưng agent không được tương tác tiếp).
   */
  async navigate(rawUrl: string, ctx?: ToolContext): Promise<string> {
    const gateDecision = this.gate.check(rawUrl, 'navigate', this.stepCounter);
    if (!gateDecision.allowed) {
      this.recordStep('navigate', `BLOCKED ${rawUrl} — ${gateDecision.reason}`, false, false, true);
      throw new Error(`Navigation blocked by egress gate: ${gateDecision.reason}`);
    }
    const url = await validateNavigateUrl(rawUrl, {
      allowLocalUrls: this.opts.allowLocalUrls,
      lookupFn: this.opts.lookupFn,
    });
    const page = await this.ensurePage(ctx?.signal);
    await page.goto(url.toString(), { timeout: this.opts.defaultNavigationTimeoutMs });
    const finalUrl = page.url();
    const finalCheck = this.gate.check(finalUrl, 'redirect', this.stepCounter);
    if (!finalCheck.allowed) {
      this.recordStep('navigate', `BLOCKED redirect to ${finalUrl} — ${finalCheck.reason}`, false, false, true);
      throw new Error(`Redirect target blocked by egress gate: ${finalCheck.reason}`);
    }
    this.currentUrl = finalUrl;
    this.recordStep('navigate', finalUrl, true);
    return finalUrl;
  }

  /** Chụp snapshot a11y-tree, trả payload (full/diff) cho model. */
  async snapshot(opts: { forceFull?: boolean } = {}, ctx?: ToolContext): Promise<BrowserV2SnapshotResult> {
    const page = await this.ensurePage(ctx?.signal);
    const raw = await page.ariaSnapshot({ timeout: this.opts.defaultActionTimeoutMs });
    const url = page.url() || this.currentUrl;
    this.currentUrl = url;
    const { payload, cached } = this.cache.capture(raw, url, { forceFull: opts.forceFull });
    this.recordStep('snapshot', `${payload.kind} ${cached.text.length} chars, ${payload.tokens} tokens`, true);
    return { step: cached.step, url, payload, nodes: cached.nodes, nodeCount: cached.text ? countNodesOf(cached.nodes) : 0 };
  }

  /** Node trong snapshot mới nhất theo ref (null khi chưa snapshot / không có). */
  findInLatestSnapshot(ref: string): A11yNode | null {
    const latest = this.cache.latest();
    if (!latest) return null;
    return findNodeByRef(latest.nodes, ref);
  }

  /** Click element theo ref trong snapshot mới nhất. */
  async clickRef(ref: string, ctx?: ToolContext): Promise<string> {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error('Missing required argument: "ref"');
    if (!this.cache.latest()) await this.snapshot({}, ctx);
    const node = this.findInLatestSnapshot(trimmed);
    if (!node) {
      this.recordStep('clickRef', `ref ${trimmed} not in accessibility tree — use browser_click_at (vision fallback)`, false);
      throw new Error(
        `No element with ref "${trimmed}" in the accessibility tree. ` +
          `The element may have no ARIA role — use browser_click_at (vision fallback) with coordinates from a screenshot instead.`,
      );
    }
    if (node.disabled) {
      this.recordStep('clickRef', `ref ${trimmed} (${node.role} "${node.name}") is disabled`, false);
      throw new Error(`Element [ref=${trimmed}] (${node.role} "${node.name}") is disabled.`);
    }
    const page = await this.ensurePage(ctx?.signal);
    await page.clickRef(trimmed, { timeout: this.opts.defaultActionTimeoutMs });
    this.verifyUrlAfterClick('clickRef', false);
    this.recordStep('clickRef', `[ref=${trimmed}] ${node.role} "${node.name}"`, true);
    return `Clicked [ref=${trimmed}] ${node.role} "${node.name}".`;
  }

  /** Điền text vào element theo ref (textbox/searchbox/combobox...). */
  async typeRef(ref: string, text: string, ctx?: ToolContext): Promise<string> {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error('Missing required argument: "ref"');
    if (text.length > 1000) throw new Error(`Text is ${text.length} chars, over the 1000 char limit.`);
    if (!this.cache.latest()) await this.snapshot({}, ctx);
    const node = this.findInLatestSnapshot(trimmed);
    if (!node) {
      this.recordStep('typeRef', `ref ${trimmed} not in accessibility tree`, false);
      throw new Error(
        `No element with ref "${trimmed}" in the accessibility tree. ` +
          `Use browser_click_at + keyboard input, or a CSS selector via browser_type.`,
      );
    }
    if (node.disabled) {
      this.recordStep('typeRef', `ref ${trimmed} is disabled`, false);
      throw new Error(`Element [ref=${trimmed}] is disabled.`);
    }
    const page = await this.ensurePage(ctx?.signal);
    await page.fillRef(trimmed, text, { timeout: this.opts.defaultActionTimeoutMs });
    this.recordStep('typeRef', `[ref=${trimmed}] ${node.role} "${node.name}" (${text.length} chars)`, true);
    return `Typed ${text.length} chars into [ref=${trimmed}] ${node.role} "${node.name}".`;
  }

  /** Click tại tọa độ (vision fallback — element không có trong tree). */
  async clickAt(x: number, y: number, ctx?: ToolContext): Promise<string> {
    const page = await this.ensurePage(ctx?.signal);
    const record = await this.vision.clickAt(x, y, {
      step: this.stepCounter,
      url: this.currentUrl,
      clicker: (cx, cy) => page.clickAt(cx, cy, { timeout: this.opts.defaultActionTimeoutMs }),
    });
    this.verifyUrlAfterClick('clickAt', true);
    this.recordStep('clickAt', `(${record.x}, ${record.y}) via vision fallback`, true, true);
    return `Clicked at (${record.x}, ${record.y}) via vision fallback.`;
  }

  /** Click element visual đã đăng ký bằng tên (tâm bbox). */
  async clickVisualElement(name: string, ctx?: ToolContext): Promise<string> {
    const page = await this.ensurePage(ctx?.signal);
    const record = await this.vision.clickElement(name, {
      step: this.stepCounter,
      url: this.currentUrl,
      clicker: (cx, cy) => page.clickAt(cx, cy, { timeout: this.opts.defaultActionTimeoutMs }),
    });
    this.verifyUrlAfterClick('clickAt', true);
    this.recordStep('clickAt', `visual element "${name}" at (${record.x}, ${record.y})`, true, true);
    return `Clicked visual element "${name}" at (${record.x}, ${record.y}).`;
  }

  /** Quay lại trang trước trong history (gate kiểm tra URL đích). */
  async goBack(ctx?: ToolContext): Promise<string> {
    const page = await this.ensurePage(ctx?.signal);
    await page.goBack({ timeout: this.opts.defaultNavigationTimeoutMs });
    const finalUrl = page.url();
    const finalCheck = this.gate.check(finalUrl, 'navigate', this.stepCounter);
    if (!finalCheck.allowed) {
      this.recordStep('goBack', `BLOCKED back to ${finalUrl} — ${finalCheck.reason}`, false, false, true);
      throw new Error(`Back target blocked by egress gate: ${finalCheck.reason}`);
    }
    this.currentUrl = finalUrl;
    this.recordStep('goBack', finalUrl, true);
    return finalUrl;
  }

  /**
   * Sau một click (ref / tọa độ / visual element), URL có thể đã đổi
   * (link / form submit / redirect): đích cuối cũng phải qua gate —
   * trang độc không được lái agent ra ngoài bằng cách dụ click.
   * Throw khi đích bị chặn (đồng thời ghi step blocked).
   */
  private verifyUrlAfterClick(action: string, viaVision: boolean): void {
    const page = this.state.page;
    if (!page) return;
    const afterUrl = page.url();
    if (!afterUrl || afterUrl === this.currentUrl) return;
    const navCheck = this.gate.check(afterUrl, 'navigate', this.stepCounter);
    if (!navCheck.allowed) {
      this.currentUrl = afterUrl;
      this.recordStep(action, `BLOCKED navigation to ${afterUrl} — ${navCheck.reason}`, false, viaVision, true);
      throw new Error(`Navigation after click blocked by egress gate: ${navCheck.reason}`);
    }
    this.currentUrl = afterUrl;
  }

  /** Kiểm tra form submit trước khi thực thi (gate). */
  checkFormSubmit(formAction: string, pageUrl?: string): EgressGateDecision {
    return this.gate.checkFormSubmit(formAction, pageUrl ?? this.currentUrl, this.stepCounter);
  }

  /** Screenshot (passthrough v1, trả Buffer). */
  async screenshot(fullPage = false, ctx?: ToolContext): Promise<Buffer> {
    const page = await this.ensurePage(ctx?.signal);
    const buf = await page.screenshot({ fullPage });
    this.recordStep('screenshot', fullPage ? 'fullPage' : 'viewport', true);
    return buf;
  }

  /** Text của trang (passthrough v1 — dùng khi snapshot không đủ). */
  async extractText(selector?: string, ctx?: ToolContext): Promise<string> {
    const page = await this.ensurePage(ctx?.signal);
    return page.innerText(selector, { timeout: this.opts.defaultActionTimeoutMs });
  }

  /** Tóm tắt phiên (dùng cho tool browser_v2_status / eval). */
  statusSummary(): string {
    const stats = this.cache.stats();
    const counts = this.gate.counts;
    return [
      `Browser v2 session: ${this.isOpen() ? 'open' : 'closed'}`,
      `URL: ${this.currentUrl || '(none)'}`,
      `Steps: ${this.stepCounter} (vision fallback: ${this.vision.clickCount})`,
      `Snapshot cache: ${stats.steps} captures, ${stats.diffsSent} diffs / ${stats.fullSnapshotsSent} full, ` +
        `${stats.tokensSaved} tokens saved (${Math.round(stats.savedRatio * 100)}%)`,
      `Egress gate: ${counts.checks} checks, ${counts.blocked} blocked`,
    ].join('\n');
  }
}

function countNodesOf(nodes: A11yNode[]): number {
  let n = 0;
  const walk = (list: A11yNode[]): void => {
    for (const node of list) {
      n += 1;
      walk(node.children);
    }
  };
  walk(nodes);
  return n;
}

/** Tạo session v2 (factory — giống `createBrowserSession` của v1). */
export function createBrowserV2Session(opts: BrowserV2Options = {}): BrowserV2Session {
  return new BrowserV2Session(opts);
}
