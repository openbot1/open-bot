/**
 * WebVoyager-style self-eval cho browser driver v2 (v1.33, Đội T4).
 *
 * Đo 3 số trên bộ task web thật (fixture local, không cần mạng ngoài):
 *  - % success (task hoàn thành theo checker khai báo),
 *  - cost/task (token snapshot đã gửi — lấy từ SnapshotCache, số thật),
 *  - steps/task.
 *
 * Mọi số eval đều kèm spec (harness version, host arch, ngày chạy,
 * dataset) — số không kèm spec là tin đồn (quy tắc survey v133).
 *
 * Chạy trong sandbox với egress allowlist BẬT: fixture host duy nhất
 * là `webvoyager.fixture`; mọi navigation/form-submit ra ngoài đều bị
 * gate chặn và được tính là một kiểu task (T-blocked) để chứng minh
 * gate hoạt động, thay vì chỉ test gate bằng unit test.
 *
 * Agent: caller truyền `stepFn` — hàm quyết định action ở mỗi step
 * dựa trên snapshot payload + URL. Harness cung cấp sẵn
 * `scriptedAgent` chạy theo script hành động khai báo trong task (đo
 * harness/driver, không đo chất lượng model); muốn đo model thật thì
 * truyền stepFn gọi model.
 *
 * Fake fixture driver: `createFixtureDriver` giả lập browser bằng map
 * URL → trang (a11y nodes + link/toggle/search-submit). Không cần
 * Chromium, không cần mạng — eval chạy được trên CI. URL ngoài fixture
 * load trang stub "External page" (driver ngu như browser thật; gate
 * của session mới là lớp chặn — xem `resolvePage`).
 */
import {
  parseAriaSnapshot,
  serializeAriaSnapshot,
  type A11yNode,
} from './a11ySnapshot';
import {
  BrowserV2Session,
  type BrowserDriverV2,
  type BrowserV2PageDriver,
} from './driverV2';

/** Host fixture duy nhất của eval (không có thật trên mạng). */
export const WEBVOYAGER_FIXTURE_HOST = 'webvoyager.fixture';
export const WEBVOYAGER_HARNESS_VERSION = 'webvoyager-v133.1';
export const WEBVOYAGER_DATASET = 'open-bot-webvoyager-local-v1';

/** Một kiểm tra khai báo (không cần code) trên trạng thái cuối. */
export type WebVoyagerCheck =
  | { kind: 'text-contains'; text: string }
  | { kind: 'url-contains'; substring: string }
  | { kind: 'ref-exists'; ref: string }
  | { kind: 'role-name-exists'; role: string; name: string }
  | { kind: 'gate-blocked'; action: string }
  | { kind: 'all'; checks: WebVoyagerCheck[] };

/** Một action mà agent (scripted hoặc model) có thể làm trong 1 step. */
export type WebVoyagerAction =
  | { type: 'clickRef'; ref: string }
  | { type: 'typeRef'; ref: string; text: string }
  | { type: 'clickAt'; x: number; y: number }
  | { type: 'navigate'; url: string }
  | { type: 'snapshot' }
  | { type: 'goBack' }
  | { type: 'done' }
  | { type: 'giveUp'; reason?: string };

/** Context đưa cho stepFn ở mỗi step. */
export interface WebVoyagerStepContext {
  task: WebVoyagerTask;
  step: number;
  url: string;
  /** Payload snapshot (full lần đầu, diff các lần sau). */
  snapshotText: string;
  snapshotKind: 'full' | 'diff';
  nodes: A11yNode[];
}

/** Hàm quyết định action (model thật hoặc scripted). */
export type WebVoyagerStepFn = (
  ctx: WebVoyagerStepContext,
) => Promise<WebVoyagerAction> | WebVoyagerAction;

/** Một task eval. */
export interface WebVoyagerTask {
  id: string;
  title: string;
  goal: string;
  startUrl: string;
  maxSteps: number;
  check: WebVoyagerCheck;
  /** Script hành động mẫu (dùng với scriptedAgent). */
  script?: WebVoyagerAction[];
}

/** Kết quả một task. */
export interface WebVoyagerTaskResult {
  taskId: string;
  title: string;
  success: boolean;
  reason: string;
  steps: number;
  tokensSent: number;
  durationMs: number;
  finalUrl: string;
  visionFallbackClicks: number;
  gateBlocks: number;
}

/** Spec kèm mọi số eval (bắt buộc — số không kèm spec là tin đồn). */
export interface WebVoyagerEvalSpec {
  harnessVersion: string;
  dataset: string;
  hostArch: string;
  runAt: string;
  taskCount: number;
}

/** Báo cáo tổng hợp một lần chạy eval. */
export interface WebVoyagerEvalReport {
  spec: WebVoyagerEvalSpec;
  successRate: number;
  passed: number;
  failed: number;
  avgStepsPerTask: number;
  avgCostTokensPerTask: number;
  totalTokensSent: number;
  avgDurationMsPerTask: number;
  results: WebVoyagerTaskResult[];
}

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

function snapshotTextOf(nodes: A11yNode[]): string {
  return serializeAriaSnapshot(nodes);
}

function nodeExists(nodes: A11yNode[], role: string, name: string): boolean {
  const walk = (list: A11yNode[]): boolean => {
    for (const n of list) {
      if (n.role === role && n.name === name) return true;
      if (walk(n.children)) return true;
    }
    return false;
  };
  return walk(nodes);
}

function refExists(nodes: A11yNode[], ref: string): boolean {
  const walk = (list: A11yNode[]): boolean => {
    for (const n of list) {
      if (n.ref === ref) return true;
      if (walk(n.children)) return true;
    }
    return false;
  };
  return walk(nodes);
}

/** Chạy một checker trên trạng thái cuối; trả {success, reason}. */
export function evaluateCheck(
  check: WebVoyagerCheck,
  state: { nodes: A11yNode[]; url: string; gateBlocks: number; blockedActions: string[] },
): { success: boolean; reason: string } {
  switch (check.kind) {
    case 'text-contains': {
      const text = snapshotTextOf(state.nodes);
      const ok = text.includes(check.text);
      return { success: ok, reason: ok ? `snapshot contains "${check.text}"` : `snapshot does not contain "${check.text}"` };
    }
    case 'url-contains': {
      const ok = state.url.includes(check.substring);
      return { success: ok, reason: ok ? `URL contains "${check.substring}"` : `URL "${state.url}" does not contain "${check.substring}"` };
    }
    case 'ref-exists': {
      const ok = refExists(state.nodes, check.ref);
      return { success: ok, reason: ok ? `ref ${check.ref} exists` : `ref ${check.ref} missing` };
    }
    case 'role-name-exists': {
      const ok = nodeExists(state.nodes, check.role, check.name);
      return { success: ok, reason: ok ? `${check.role} "${check.name}" exists` : `${check.role} "${check.name}" missing` };
    }
    case 'gate-blocked': {
      const ok = state.blockedActions.includes(check.action);
      return {
        success: ok,
        reason: ok ? `gate blocked "${check.action}" as expected` : `gate did not block "${check.action}"`,
      };
    }
    case 'all': {
      for (const sub of check.checks) {
        const r = evaluateCheck(sub, state);
        if (!r.success) return { success: false, reason: `all-check failed: ${r.reason}` };
      }
      return { success: true, reason: 'all checks passed' };
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture pages (fake browser — không mạng, không Chromium)
// ---------------------------------------------------------------------------

/** Hành vi khi click một ref trên trang fixture. */
export type FixtureClickAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'setText'; ref: string; text: string }
  | { kind: 'searchSubmit' }
  | { kind: 'canvasClick' };

/** Định nghĩa một trang fixture. */
export interface FixturePageDef {
  url: string;
  title: string;
  /** Snapshot text (ref sẽ được cấp lại ổn định theo DFS nếu thiếu). */
  snapshot: string;
  /** Click ref → hành vi (mặc định: không làm gì). */
  clicks?: Record<string, FixtureClickAction>;
  /** Click tọa độ (vision fallback) → text đặt vào ref (canvas). */
  clickAtText?: { ref: string; text: string };
}

const FIXTURE_HOME = `https://${WEBVOYAGER_FIXTURE_HOST}/`;
const FIXTURE_SEARCH = `https://${WEBVOYAGER_FIXTURE_HOST}/search`;
const FIXTURE_ARTICLE = `https://${WEBVOYAGER_FIXTURE_HOST}/article/cats`;
const FIXTURE_PRODUCT = `https://${WEBVOYAGER_FIXTURE_HOST}/product/widget`;
const FIXTURE_CART = `https://${WEBVOYAGER_FIXTURE_HOST}/cart`;
const FIXTURE_CANVAS = `https://${WEBVOYAGER_FIXTURE_HOST}/canvas`;
const FIXTURE_EVIL_FORM = `https://${WEBVOYAGER_FIXTURE_HOST}/evil-form`;

function fixturePages(): FixturePageDef[] {
  return [
    {
      url: FIXTURE_HOME,
      title: 'Fixture Home',
      snapshot: [
        '- heading "Fixture Store" [level=1]',
        '- textbox "Search products" [ref=e1]',
        '- button "Search" [ref=e2]',
        '- link "Widget Pro" [ref=e3]',
        '- link "Canvas demo" [ref=e4]',
        '- link "Suspicious form" [ref=e5]',
        '- text: Welcome to the fixture store.',
      ].join('\n'),
      clicks: {
        e2: { kind: 'searchSubmit' },
        e3: { kind: 'navigate', url: FIXTURE_PRODUCT },
        e4: { kind: 'navigate', url: FIXTURE_CANVAS },
        e5: { kind: 'navigate', url: FIXTURE_EVIL_FORM },
      },
    },
    {
      url: FIXTURE_SEARCH,
      title: 'Search results',
      snapshot: [
        '- heading "Search results" [level=1]',
        '- text: Results for your query.',
        '- link "Cats: a complete guide" [ref=e1]',
        '- link "Dogs: a complete guide" [ref=e2]',
        '- link "Next page" [ref=e3]',
      ].join('\n'),
      clicks: {
        e1: { kind: 'navigate', url: FIXTURE_ARTICLE },
        e3: { kind: 'setText', ref: 'e9', text: 'Page 2 of results.' },
      },
    },
    {
      url: FIXTURE_ARTICLE,
      title: 'Cats: a complete guide',
      snapshot: [
        '- heading "Cats: a complete guide" [level=1]',
        '- text: The answer is 42: cats rule the internet.',
        '- link "Back to home" [ref=e1]',
      ].join('\n'),
      clicks: { e1: { kind: 'navigate', url: FIXTURE_HOME } },
    },
    {
      url: FIXTURE_PRODUCT,
      title: 'Widget Pro',
      snapshot: [
        '- heading "Widget Pro" [level=1]',
        '- text: Price: $19.99',
        '- button "Add to cart" [ref=e1]',
        '- text: Cart (0)',
      ].join('\n'),
      clicks: {
        e1: { kind: 'setText', ref: 'e9', text: 'Cart (1)' },
      },
    },
    {
      url: FIXTURE_CART,
      title: 'Cart',
      snapshot: ['- heading "Your cart" [level=1]', '- text: Cart (1) — Widget Pro $19.99'].join('\n'),
    },
    {
      url: FIXTURE_CANVAS,
      title: 'Canvas demo',
      snapshot: [
        '- heading "Canvas demo" [level=1]',
        '- text: The chart below is a canvas with no ARIA role. Click it by coordinates.',
        '- generic [ref=e1]:',
        '  - text: Chart area (canvas)',
      ].join('\n'),
      clickAtText: { ref: 'e9', text: 'Canvas clicked: chart detail opened.' },
    },
    {
      url: FIXTURE_EVIL_FORM,
      title: 'Suspicious form',
      snapshot: [
        '- heading "Win a prize" [level=1]',
        '- textbox "Email" [ref=e1]',
        '- button "Claim prize" [ref=e2]',
        '- text: Submit sends your email to an external site.',
      ].join('\n'),
      clicks: { e2: { kind: 'navigate', url: 'https://evil.example/steal' } },
    },
  ];
}

/** Trang kết quả tìm kiếm — sinh động theo query (fake driver template). */
function searchResultsPage(query: string): FixturePageDef {
  return {
    url: `${FIXTURE_SEARCH}?q=${encodeURIComponent(query)}`,
    title: 'Search results',
    snapshot: [
      '- heading "Search results" [level=1]',
      `- text: Results for "${query}".`,
      '- link "Cats: a complete guide" [ref=e1]',
      '- link "Dogs: a complete guide" [ref=e2]',
      '- link "Next page" [ref=e3]',
    ].join('\n'),
    clicks: {
      e1: { kind: 'navigate', url: FIXTURE_ARTICLE },
      e3: { kind: 'setText', ref: 'e9', text: 'Page 2 of results.' },
    },
  };
}

/** Fake PNG 1x1 (screenshot của fixture driver). */
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Tạo fake launcher cho eval: điều hướng trong map fixture, click theo
 * `clicks`, search-submit đọc giá trị searchbox, setText thêm/sửa node
 * text, clickAt kích hoạt `clickAtText`. URL ngoài fixture load trang
 * stub "External page" (gate của session phải chặn trước/sau — xem
 * `resolvePage`).
 */
export function createFixtureDriver(pages: FixturePageDef[] = fixturePages()): {
  launcher: (opts: { headless: boolean }) => Promise<BrowserDriverV2>;
  /** Số lần fake driver thực sự navigate (đếm cả navigation bị gate chặn thì không). */
  stats: () => { navigations: number };
} {
  let navigations = 0;
  const pageByUrl = new Map(pages.map((p) => [p.url, p]));

  const resolvePage = (url: string): FixturePageDef => {
    const exact = pageByUrl.get(url);
    if (exact) return exact;
    if (url.startsWith(`${FIXTURE_SEARCH}?q=`)) {
      const query = decodeURIComponent(url.slice(`${FIXTURE_SEARCH}?q=`.length));
      return searchResultsPage(query);
    }
    // URL ngoài fixture: driver (ngu, như browser thật) vẫn "load" được
    // một trang stub — lớp chặn là egress gate của session, không phải
    // driver. Qua `session.navigate` gate chặn TRƯỚC nên URL độc không
    // bao giờ tới đây; qua click (link/form) gate chặn SAU click nhờ
    // verifyUrlAfterClick. Nếu driver throw ở đây thì gate không bao
    // giờ có cơ hội chặn — đó là bug đã gặp ở eval wv-egress-blocked.
    return {
      url,
      title: 'External page',
      snapshot: '- heading "External page" [level=1]\n- text: This page is outside the fixture.',
      clicks: {},
    };
  };

  const launcher = async (): Promise<BrowserDriverV2> => {
    // State của một page (đóng trong closure của driver).
    let current: FixturePageDef | null = null;
    let nodes: A11yNode[] = [];
    let searchValue = '';
    let history: string[] = [];
    let closed = false;

    const load = (url: string): void => {
      const def = resolvePage(url);
      // Deep copy nodes để setText không làm bẩn fixture gốc.
      nodes = parseAriaSnapshot(def.snapshot).map((n) => JSON.parse(JSON.stringify(n)) as A11yNode);
      current = def;
      history.push(url);
      navigations += 1;
    };

    const setTextNode = (ref: string, text: string): void => {
      // Tìm node text có ref đó; nếu chưa có, thêm node text mới vào cuối.
      const walk = (list: A11yNode[]): boolean => {
        for (const n of list) {
          if (n.ref === ref && n.role === 'text') {
            n.name = text;
            return true;
          }
          if (walk(n.children)) return true;
        }
        return false;
      };
      if (!walk(nodes)) {
        nodes.push({ ref, role: 'text', name: text, children: [] });
      }
    };

    const page: BrowserV2PageDriver = {
      url: () => current?.url ?? '',
      title: () => Promise.resolve(current?.title ?? ''),
      goto: (url) => {
        if (closed) return Promise.reject(new Error('Fixture page is closed.'));
        load(url);
        return Promise.resolve();
      },
      click: (selector) => {
        // Fake v1 click: chỉ hỗ trợ selector dạng `#id` trỏ tới ref — không dùng trong eval.
        void selector;
        return Promise.resolve();
      },
      fill: (selector, text) => {
        void selector;
        searchValue = text;
        return Promise.resolve();
      },
      screenshot: () => Promise.resolve(Buffer.from(FAKE_PNG)),
      innerText: () => Promise.resolve(serializeAriaSnapshot(nodes)),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      ariaSnapshot: () => Promise.resolve(serializeAriaSnapshot(nodes)),
      clickRef: (ref) => {
        const def = current;
        if (!def) return Promise.reject(new Error('No page loaded.'));
        const action = def.clicks?.[ref];
        if (!action) return Promise.resolve();
        if (action.kind === 'navigate') {
          load(action.url);
        } else if (action.kind === 'setText') {
          setTextNode(action.ref, action.text);
        } else if (action.kind === 'searchSubmit') {
          load(`${FIXTURE_SEARCH}?q=${encodeURIComponent(searchValue || 'cats')}`);
        } else if (action.kind === 'canvasClick') {
          setTextNode('e9', 'Canvas clicked.');
        }
        return Promise.resolve();
      },
      fillRef: (ref, text) => {
        // Ghi value vào node textbox + nhớ cho search-submit.
        const walk = (list: A11yNode[]): boolean => {
          for (const n of list) {
            if (n.ref === ref) {
              n.value = text;
              return true;
            }
            if (walk(n.children)) return true;
          }
          return false;
        };
        walk(nodes);
        searchValue = text;
        return Promise.resolve();
      },
      clickAt: (x, y) => {
        void x;
        void y;
        const def = current;
        if (def?.clickAtText) setTextNode(def.clickAtText.ref, def.clickAtText.text);
        return Promise.resolve();
      },
      viewportSize: () => Promise.resolve({ width: 1280, height: 720 }),
      goBack: () => {
        if (history.length >= 2) {
          history.pop();
          const prev = history[history.length - 1];
          // Load lại nhưng không push thêm vào history lần nữa.
          const def = resolvePage(prev);
          nodes = parseAriaSnapshot(def.snapshot).map((n) => JSON.parse(JSON.stringify(n)) as A11yNode);
          current = def;
        }
        return Promise.resolve();
      },
    };
    return {
      newPage: () => Promise.resolve(page),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
  };

  return { launcher, stats: () => ({ navigations }) };
}

// ---------------------------------------------------------------------------
// Bộ task mẫu (fixture local)
// ---------------------------------------------------------------------------

export const WEBVOYAGER_TASKS: WebVoyagerTask[] = [
  {
    id: 'wv-find-article',
    title: 'Search and open the cats article',
    goal: 'Search for "cats", open the cats article, confirm its text.',
    startUrl: FIXTURE_HOME,
    maxSteps: 8,
    check: { kind: 'text-contains', text: 'The answer is 42' },
    script: [
      { type: 'typeRef', ref: 'e1', text: 'cats' },
      { type: 'clickRef', ref: 'e2' },
      { type: 'clickRef', ref: 'e1' },
      { type: 'done' },
    ],
  },
  {
    id: 'wv-check-price',
    title: 'Check the Widget Pro price',
    goal: 'Open the Widget Pro product page and confirm the price $19.99.',
    startUrl: FIXTURE_HOME,
    maxSteps: 6,
    check: { kind: 'text-contains', text: '$19.99' },
    script: [
      { type: 'clickRef', ref: 'e3' },
      { type: 'done' },
    ],
  },
  {
    id: 'wv-add-to-cart',
    title: 'Add Widget Pro to cart',
    goal: 'Open the product page, click Add to cart, confirm Cart (1).',
    startUrl: FIXTURE_HOME,
    maxSteps: 6,
    check: { kind: 'text-contains', text: 'Cart (1)' },
    script: [
      { type: 'clickRef', ref: 'e3' },
      { type: 'clickRef', ref: 'e1' },
      { type: 'done' },
    ],
  },
  {
    id: 'wv-pagination',
    title: 'Go to page 2 of search results',
    goal: 'Search, then go to the next page of results.',
    startUrl: FIXTURE_HOME,
    maxSteps: 8,
    check: { kind: 'text-contains', text: 'Page 2 of results.' },
    script: [
      { type: 'typeRef', ref: 'e1', text: 'cats' },
      { type: 'clickRef', ref: 'e2' },
      { type: 'clickRef', ref: 'e3' },
      { type: 'done' },
    ],
  },
  {
    id: 'wv-go-back',
    title: 'Go back to home from the article',
    goal: 'Open the article, then go back and confirm the home page.',
    startUrl: FIXTURE_HOME,
    maxSteps: 8,
    check: { kind: 'text-contains', text: 'Welcome to the fixture store.' },
    script: [
      { type: 'typeRef', ref: 'e1', text: 'cats' },
      { type: 'clickRef', ref: 'e2' },
      { type: 'clickRef', ref: 'e1' },
      { type: 'goBack' },
      { type: 'goBack' },
      { type: 'done' },
    ],
  },
  {
    id: 'wv-vision-canvas',
    title: 'Click the canvas by coordinates (vision fallback)',
    goal: 'Open the canvas demo and click the chart by coordinates (it has no ARIA role).',
    startUrl: FIXTURE_HOME,
    maxSteps: 6,
    check: { kind: 'text-contains', text: 'Canvas clicked' },
    script: [
      { type: 'clickRef', ref: 'e4' },
      { type: 'clickAt', x: 640, y: 360 },
      { type: 'done' },
    ],
  },
  {
    id: 'wv-egress-blocked',
    title: 'Egress gate blocks the malicious form target',
    goal: 'Open the suspicious form and try to reach the external prize site — the gate must block it.',
    startUrl: FIXTURE_HOME,
    maxSteps: 6,
    check: { kind: 'gate-blocked', action: 'navigate' },
    script: [
      { type: 'clickRef', ref: 'e5' },
      { type: 'clickRef', ref: 'e2' },
      { type: 'done' },
    ],
  },
  {
    id: 'wv-direct-navigate',
    title: 'Direct navigate to the cart page',
    goal: 'Navigate directly to the cart page and confirm its content.',
    startUrl: FIXTURE_CART,
    maxSteps: 4,
    check: { kind: 'text-contains', text: 'Widget Pro $19.99' },
    script: [{ type: 'done' }],
  },
];

/** Agent scripted: chạy lần lượt script của task, `done` thì dừng. */
export function scriptedAgent(task: WebVoyagerTask): WebVoyagerStepFn {
  let index = 0;
  return () => {
    const action = task.script?.[index];
    index += 1;
    return action ?? { type: 'done' };
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface WebVoyagerRunnerOptions {
  /** Factory session (mặc định: session mới với fixture driver + gate chỉ cho fixture host). */
  sessionFactory?: () => BrowserV2Session;
  /** Ghi log tiến trình ra stderr (mặc định false). */
  verbose?: boolean;
}

function defaultSessionFactory(): BrowserV2Session {
  const { launcher } = createFixtureDriver();
  return new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: [WEBVOYAGER_FIXTURE_HOST, `*.${WEBVOYAGER_FIXTURE_HOST}`] },
  });
}

async function runSingleTask(
  task: WebVoyagerTask,
  stepFn: WebVoyagerStepFn,
  sessionFactory: () => BrowserV2Session,
): Promise<WebVoyagerTaskResult> {
  const startedAt = Date.now();
  const session = sessionFactory();
  let steps = 0;
  let reason = 'gave up';
  let done = false;
  const blockedActions: string[] = [];
  try {
    await session.navigate(task.startUrl);
    for (let step = 0; step < task.maxSteps && !done; step += 1) {
      steps = step + 1;
      const snap = await session.snapshot();
      const action = await stepFn({
        task,
        step,
        url: session.url,
        snapshotText: snap.payload.text,
        snapshotKind: snap.payload.kind,
        nodes: snap.nodes,
      });
      switch (action.type) {
        case 'done':
          done = true;
          reason = 'agent reported done';
          break;
        case 'giveUp':
          done = true;
          reason = action.reason ?? 'agent gave up';
          break;
        case 'clickRef':
          await session.clickRef(action.ref);
          break;
        case 'typeRef':
          await session.typeRef(action.ref, action.text);
          break;
        case 'clickAt':
          await session.clickAt(action.x, action.y);
          break;
        case 'navigate':
          await session.navigate(action.url);
          break;
        case 'goBack':
          await session.goBack();
          break;
        case 'snapshot':
          break;
      }
    }
    if (!done) reason = `max steps reached (${task.maxSteps})`;
  } catch (err) {
    reason = `error: ${(err as Error).message}`;
  }
  // Trạng thái cuối để checker chạy (snapshot mới nhất trong cache).
  const latest = session.cache.latest();
  const finalNodes = latest?.nodes ?? [];
  const finalUrl = session.url;
  const blocks = session.gate.blocks;
  for (const b of blocks) blockedActions.push(b.action);
  const checkResult = evaluateCheck(task.check, {
    nodes: finalNodes,
    url: finalUrl,
    gateBlocks: blocks.length,
    blockedActions,
  });
  // Task egress-blocked: thành công = gate đã chặn (checker quyết định);
  // task thường: thành công = checker pass và agent không lỗi giữa chừng.
  const success = checkResult.success;
  if (success) reason = checkResult.reason;
  else if (reason.startsWith('agent reported done') || reason.startsWith('max steps')) {
    reason = `check failed: ${checkResult.reason}`;
  }
  const stats = session.cache.stats();
  const result: WebVoyagerTaskResult = {
    taskId: task.id,
    title: task.title,
    success,
    reason,
    steps,
    tokensSent: stats.totalSentTokens,
    durationMs: Date.now() - startedAt,
    finalUrl,
    visionFallbackClicks: session.vision.clickCount,
    gateBlocks: blocks.length,
  };
  await session.close().catch(() => undefined);
  return result;
}

/**
 * Chạy bộ task WebVoyager-local. `stepFnFactory` nhận task và trả stepFn
 * (mặc định: scriptedAgent theo script của task).
 */
export async function runWebVoyagerEval(
  tasks: WebVoyagerTask[] = WEBVOYAGER_TASKS,
  opts: WebVoyagerRunnerOptions & {
    stepFnFactory?: (task: WebVoyagerTask) => WebVoyagerStepFn;
  } = {},
): Promise<WebVoyagerEvalReport> {
  const sessionFactory = opts.sessionFactory ?? defaultSessionFactory;
  const stepFnFactory = opts.stepFnFactory ?? scriptedAgent;
  const results: WebVoyagerTaskResult[] = [];
  for (const task of tasks) {
    const result = await runSingleTask(task, stepFnFactory(task), sessionFactory);
    results.push(result);
    if (opts.verbose) {
      process.stderr.write(
        `[webvoyager] ${task.id}: ${result.success ? 'PASS' : 'FAIL'} ` +
          `(${result.steps} steps, ${result.tokensSent} tokens, ${result.reason})\n`,
      );
    }
  }
  const passed = results.filter((r) => r.success).length;
  const total = results.length;
  const totalTokens = results.reduce((s, r) => s + r.tokensSent, 0);
  const totalSteps = results.reduce((s, r) => s + r.steps, 0);
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  return {
    spec: {
      harnessVersion: WEBVOYAGER_HARNESS_VERSION,
      dataset: WEBVOYAGER_DATASET,
      hostArch: `${process.platform}/${process.arch}`,
      runAt: new Date().toISOString(),
      taskCount: total,
    },
    successRate: total === 0 ? 0 : passed / total,
    passed,
    failed: total - passed,
    avgStepsPerTask: total === 0 ? 0 : totalSteps / total,
    avgCostTokensPerTask: total === 0 ? 0 : totalTokens / total,
    totalTokensSent: totalTokens,
    avgDurationMsPerTask: total === 0 ? 0 : totalMs / total,
    results,
  };
}

/** Render báo cáo thành text (dùng cho tool + log). */
export function renderWebVoyagerReport(report: WebVoyagerEvalReport): string {
  const lines: string[] = [];
  lines.push(
    `WebVoyager-local eval (${report.spec.harnessVersion}, dataset ${report.spec.dataset}, ` +
      `${report.spec.hostArch}, ${report.spec.runAt}):`,
  );
  lines.push(
    `Success: ${report.passed}/${report.spec.taskCount} (${Math.round(report.successRate * 100)}%), ` +
      `avg ${report.avgStepsPerTask.toFixed(1)} steps/task, ` +
      `avg ${Math.round(report.avgCostTokensPerTask)} tokens/task, ` +
      `total ${report.totalTokensSent} tokens.`,
  );
  for (const r of report.results) {
    lines.push(
      `- [${r.success ? 'PASS' : 'FAIL'}] ${r.taskId}: ${r.steps} steps, ${r.tokensSent} tokens, ${r.reason}`,
    );
  }
  return lines.join('\n');
}

