/**
 * Composio toolkit MOCK v1.20 — 4 toolkit moi: Trello, Wave,
 * Basecamp, Zoho (v1.20, Doi T4).
 *
 * MOCK-ONLY — CUNG TU THE v110/v111/v112/v114/v118/v119:
 *
 * - Vault hien KHONG co Composio API key, nen KHONG co cach nao goi
 *   Composio that trong song nay. Moi thu trong file nay chay hoan
 *   toan local, khong goi mang, khong can key.
 * - Slug tool liet ke o day la SLUG UNG VIEN (candidate), dat theo
 *   quy uoc dat ten cua Composio (PREFIX_VERB_NOUN), KHONG PHAI slug
 *   da xac nhan live. 4 toolkit nay KHONG nam trong COMPOSIO_TOOLKITS
 *   (40 toolkit da xac nhan live van nguyen ven), ma song rieng o day
 *   duoi co `mockOnly: true, liveVerified: false`.
 * - De bat live sau nay (khi Huy da nhap key that vao Vault):
 *   1. Goi `GET /api/v3.1/tools?toolkit_slug=<slug>` voi key that,
 *      doi chieu tung slug ung vien voi slug that Composio tra ve.
 *   2. Slug nao khop thi chuyen toolkit do sang COMPOSIO_TOOLKITS
 *      (theo dung 10 slug/cap M7), cap nhat pin dem trong
 *      tests/composio-toolkits-a.test.mjs (40 -> 44 toolkit,
 *      400 -> 440 slug) — coordinator gop tinh lai.
 *   3. Slug nao khong khop thi sua/xoa, KHONG duoc giu slug bia
 *      trong catalog live (bai hoc SLACK_POST_MESSAGE v0.57).
 * - Mock executor (`MockComposioV120Executor`) tra du lieu mau xac
 *   dinh (deterministic, khong random, khong thoi gian thuc) cho
 *   tung slug, du de UI + agent loop + test chay end-to-end ma
 *   khong can key. Moi response deu mang `mock: true, live: false`
 *   + ghi chu can key that de chay live.
 * - Moi toolkit mang them `authKind` + `authNote`: cach xac thuc
 *   ma user se can khi bat live (OAuth2 qua Composio managed auth
 *   hay API key rieng), de UI hien dung huong dan ket noi.
 * - Moi trong v120 (so voi v119): moi slug ung vien kem theo danh
 *   sach ten param ky vong (`paramNames`) — de toolkit prefs v120
 *   kiem tra default params cua user truoc khi luu (param la thi
 *   bao loi ngay, khong doi toi luc chay moi biet).
 * - Chon 4 toolkit nay vi chung KHONG trung 40 toolkit live
 *   (gmail/github/slack/notion/jira/linear/asana/hubspot/...) va
 *   KHONG trung 6 toolkit mock v110 (figma/supabase/vercel/
 *   todoist/intercom/miro), 6 toolkit mock v111 (sentry/
 *   datadog/posthog/snowflake/amplitude/mixpanel), 6 toolkit mock
 *   v112 (grafana/elasticsearch/bigquery/clickhouse/
 *   launchdarkly/greenhouse), 6 toolkit mock v114 (webflow/
 *   pipedrive/chargebee/xero/eventbrite/surveymonkey), 3 toolkit
 *   mock v118 (canva/docusign/loom) hay 3 toolkit mock v119
 *   (wrike/bamboohr/ringcentral): quan ly cong viec dang bang
 *   (Trello) + ke toan hoa don (Wave, Zoho) + cong tac
 *   nhom (Basecamp) la 4 nhom app integration con thieu cho doi
 *   nhom van phong — dung huong san pham chung, khong phai niche.
 *   Luu y: Wave KHAC Freshdesk (Freshdesk da live o v0.96);
 *   Zoho KHAC Xero (Xero la mock v114).
 */

import type { AppDefinition } from '../apps/types';
import { composioAppId, composioToolNeedsApproval } from './toolkits';

/** Cach xac thuc cua mot toolkit khi bat live qua Composio. */
export type ComposioV120AuthKind = 'oauth2' | 'api-key' | 'oauth2-or-api-key';

/** Khai bao mot toolkit MOCK (chua xac nhan live). */
export interface ComposioV120MockToolkitDef {
  /** Slug toolkit Composio ung vien, vd 'trello'. */
  slug: string;
  /** Ten hien thi. */
  label: string;
  /** Bieu tuong hien thi. */
  icon: string;
  /** Mo ta ngan cho UI — luon noi ro day la mock, chua live. */
  description: string;
  /** Slug tool UNG VIEN (chua xac nhan live — xem ghi chu dau file). */
  candidateToolSlugs: string[];
  /** Cach xac thuc khi bat live (de UI hien dung huong dan). */
  authKind: ComposioV120AuthKind;
  /** Ghi chu xac thuc: user can chuan bi gi truoc khi ket noi live. */
  authNote: string;
  /** Luon true trong module nay: toolkit chi chay bang mock. */
  mockOnly: true;
  /** Luon false cho toi khi co nguoi doi chieu slug voi API that. */
  liveVerified: false;
}

/**
 * 4 toolkit mock — 10 slug ung vien moi toolkit (bang cap M7
 * `DEFAULT_APP_TOOL_CAP = 10`). Slug ung vien, CHUA xac nhan live.
 */
export const COMPOSIO_V120_MOCK_TOOLKITS: readonly ComposioV120MockToolkitDef[] = [
  {
    slug: 'trello',
    label: 'Trello (mock — via Composio)',
    icon: '🗂️',
    description:
      '[MOCK] Doc/tạo board/list/card Trello qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'TRELLO_LIST_BOARDS',
      'TRELLO_GET_BOARD',
      'TRELLO_CREATE_BOARD',
      'TRELLO_LIST_LISTS',
      'TRELLO_CREATE_LIST',
      'TRELLO_LIST_CARDS',
      'TRELLO_GET_CARD',
      'TRELLO_CREATE_CARD',
      'TRELLO_UPDATE_CARD',
      'TRELLO_MOVE_CARD',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Trello va cap quyen doc/ghi board, khong can API token rieng.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'wave',
    label: 'Wave (mock — via Composio)',
    icon: '🌊',
    description:
      '[MOCK] Doc/tạo hoa don/khach hang Wave qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'WAVE_LIST_INVOICES',
      'WAVE_GET_INVOICE',
      'WAVE_CREATE_INVOICE',
      'WAVE_UPDATE_INVOICE',
      'WAVE_DELETE_INVOICE',
      'WAVE_LIST_CLIENTS',
      'WAVE_GET_CLIENT',
      'WAVE_CREATE_CLIENT',
      'WAVE_LIST_PAYMENTS',
      'WAVE_CREATE_PAYMENT',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Wave va chon tai khoan cong ty.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'basecamp',
    label: 'Basecamp (mock — via Composio)',
    icon: '🏕️',
    description:
      '[MOCK] Doc/tạo project/todo/message Basecamp qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'BASECAMP_LIST_PROJECTS',
      'BASECAMP_GET_PROJECT',
      'BASECAMP_CREATE_PROJECT',
      'BASECAMP_LIST_TODOLISTS',
      'BASECAMP_CREATE_TODOLIST',
      'BASECAMP_LIST_TODOS',
      'BASECAMP_CREATE_TODO',
      'BASECAMP_COMPLETE_TODO',
      'BASECAMP_LIST_MESSAGES',
      'BASECAMP_CREATE_MESSAGE',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Basecamp va chon tai khoan.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'zoho',
    label: 'Zoho (mock — via Composio)',
    icon: '💰',
    description:
      '[MOCK] Doc/tạo hoa don/khach hang/chi phi Zoho qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'ZOHO_LIST_INVOICES',
      'ZOHO_GET_INVOICE',
      'ZOHO_CREATE_INVOICE',
      'ZOHO_LIST_CUSTOMERS',
      'ZOHO_GET_CUSTOMER',
      'ZOHO_CREATE_CUSTOMER',
      'ZOHO_LIST_EXPENSES',
      'ZOHO_CREATE_EXPENSE',
      'ZOHO_LIST_ACCOUNTS',
      'ZOHO_GET_COMPANY_INFO',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Zoho Books va chon cong ty; can sandbox neu chi muon thu.',
    mockOnly: true,
    liveVerified: false,
  },
];

/**
 * Ten param ky vong cua tung slug ung vien v120 (de toolkit prefs
 * v120 kiem tra default params). Day la DANH SACH TEN — khong phai
 * schema day du (kieu du lieu do live API quyet dinh sau). Slug nao
 * khong co trong bang thi chap nhan bat ky param nao (khong kiem tra).
 */
export const COMPOSIO_V120_MOCK_TOOL_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  TRELLO_LIST_BOARDS: ['memberId', 'limit'],
  TRELLO_GET_BOARD: ['boardId'],
  TRELLO_CREATE_BOARD: ['name', 'description'],
  TRELLO_LIST_LISTS: ['boardId'],
  TRELLO_CREATE_LIST: ['boardId', 'name'],
  TRELLO_LIST_CARDS: ['boardId', 'listId', 'limit'],
  TRELLO_GET_CARD: ['cardId'],
  TRELLO_CREATE_CARD: ['listId', 'name', 'description'],
  TRELLO_UPDATE_CARD: ['cardId', 'name', 'description'],
  TRELLO_MOVE_CARD: ['cardId', 'listId'],
  WAVE_LIST_INVOICES: ['clientId', 'status', 'limit'],
  WAVE_GET_INVOICE: ['invoiceId'],
  WAVE_CREATE_INVOICE: ['clientId', 'amount', 'currency'],
  WAVE_UPDATE_INVOICE: ['invoiceId', 'amount', 'status'],
  WAVE_DELETE_INVOICE: ['invoiceId'],
  WAVE_LIST_CLIENTS: ['limit'],
  WAVE_GET_CLIENT: ['clientId'],
  WAVE_CREATE_CLIENT: ['name', 'email'],
  WAVE_LIST_PAYMENTS: ['invoiceId', 'limit'],
  WAVE_CREATE_PAYMENT: ['invoiceId', 'amount'],
  BASECAMP_LIST_PROJECTS: ['limit'],
  BASECAMP_GET_PROJECT: ['projectId'],
  BASECAMP_CREATE_PROJECT: ['name', 'description'],
  BASECAMP_LIST_TODOLISTS: ['projectId'],
  BASECAMP_CREATE_TODOLIST: ['projectId', 'name'],
  BASECAMP_LIST_TODOS: ['projectId', 'todolistId'],
  BASECAMP_CREATE_TODO: ['todolistId', 'content', 'assigneeId'],
  BASECAMP_COMPLETE_TODO: ['todoId'],
  BASECAMP_LIST_MESSAGES: ['projectId', 'limit'],
  BASECAMP_CREATE_MESSAGE: ['projectId', 'subject', 'content'],
  ZOHO_LIST_INVOICES: ['customerId', 'limit'],
  ZOHO_GET_INVOICE: ['invoiceId'],
  ZOHO_CREATE_INVOICE: ['customerId', 'amount', 'currency'],
  ZOHO_LIST_CUSTOMERS: ['limit'],
  ZOHO_GET_CUSTOMER: ['customerId'],
  ZOHO_CREATE_CUSTOMER: ['name', 'email'],
  ZOHO_LIST_EXPENSES: ['limit'],
  ZOHO_CREATE_EXPENSE: ['accountId', 'amount', 'description'],
  ZOHO_LIST_ACCOUNTS: ['limit'],
  ZOHO_GET_COMPANY_INFO: [],
};

/** Tat ca slug ung vien cua 4 toolkit mock v120 (40 slug). */
export function mockComposioV120Slugs(): string[] {
  return COMPOSIO_V120_MOCK_TOOLKITS.flatMap((t) => [...t.candidateToolSlugs]);
}

/** Mot toolkit mock v120 theo slug, hoac undefined khi khong co. */
export function findMockComposioV120Toolkit(slug: string): ComposioV120MockToolkitDef | undefined {
  return COMPOSIO_V120_MOCK_TOOLKITS.find((t) => t.slug === slug);
}

/** true khi slug la slug tool ung vien cua mot toolkit mock v120. */
export function isMockComposioV120Slug(slug: string): boolean {
  return COMPOSIO_V120_MOCK_TOOLKITS.some((t) => t.candidateToolSlugs.includes(slug));
}

/** Tool mock co can approval khong — cung luat dong tu ghi nhu tool Composio that. */
export function mockComposioV120ToolNeedsApproval(slug: string): boolean {
  return composioToolNeedsApproval(slug);
}

/** App id cua mot toolkit mock: 'composio-<toolkit>' (cung quy uoc voi toolkit that). */
export function mockComposioV120AppId(toolkit: string): string {
  return composioAppId(toolkit);
}

/** Ten param ky vong cua mot slug (undefined = khong co bang, khong kiem tra). */
export function mockComposioV120ParamNames(slug: string): readonly string[] | undefined {
  return COMPOSIO_V120_MOCK_TOOL_PARAM_NAMES[slug];
}

/**
 * AppDefinition cho 4 toolkit mock — de UI bat/tat + liet ke tool
 * nhu toolkit that, nhung mo ta luon gan co [MOCK] de nguoi dung
 * khong nham voi ket noi live.
 */
export function createMockComposioV120AppDefinitions(): AppDefinition[] {
  return COMPOSIO_V120_MOCK_TOOLKITS.map((toolkit) => ({
    id: mockComposioV120AppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.candidateToolSlugs.map((slug) => ({
      name: slug,
      description: `[MOCK] Tool Composio ${slug} — slug ung vien chua xac nhan live, chi chay bang du lieu mau local.`,
      needsApproval: mockComposioV120ToolNeedsApproval(slug),
    })),
  }));
}

/** Tom tat catalogue mock v120: dem toolkit/slug + tach tool ghi/doc. */
export function summarizeMockComposioV120Catalogue(): {
  totalToolkits: number;
  totalSlugs: number;
  writeSlugs: number;
  readSlugs: number;
  byToolkit: { slug: string; total: number; write: number; read: number; authKind: ComposioV120AuthKind }[];
} {
  const byToolkit = COMPOSIO_V120_MOCK_TOOLKITS.map((t) => {
    const write = t.candidateToolSlugs.filter((s) => mockComposioV120ToolNeedsApproval(s)).length;
    return {
      slug: t.slug,
      total: t.candidateToolSlugs.length,
      write,
      read: t.candidateToolSlugs.length - write,
      authKind: t.authKind,
    };
  });
  const writeSlugs = byToolkit.reduce((n, b) => n + b.write, 0);
  return {
    totalToolkits: COMPOSIO_V120_MOCK_TOOLKITS.length,
    totalSlugs: mockComposioV120Slugs().length,
    writeSlugs,
    readSlugs: mockComposioV120Slugs().length - writeSlugs,
    byToolkit,
  };
}

// ---------------------------------------------------------------------------
// Mock executor — du lieu mau xac dinh cho tung slug
// ---------------------------------------------------------------------------

export interface MockComposioV120Result {
  mock: true;
  live: false;
  toolkit: string;
  slug: string;
  /** Du lieu mau (da gop field echo tu args khi ten field trung). */
  data: Record<string, unknown>;
  /** Ghi chu bat live: can key that + xac nhan slug. */
  note: string;
}

const MOCK_LIVE_NOTE =
  'Mock response — no live Composio call was made. To run for real, add a Composio API key to the Vault and verify this slug against the live Composio catalog first.';

/**
 * Du lieu mau cho tung slug ung vien. Moi mau la mot object phang
 * (field nao cung la string/number/boolean/array phang) de test va
 * UI doc duoc ma khong can schema live. `args` cua caller duoc echo
 * vao `data.echo` nguyen ven — mock khong bao gio "thuc thi" gi.
 */
const MOCK_SAMPLES: Record<string, Record<string, unknown>> = {
  // Trello
  TRELLO_LIST_BOARDS: { boards: [{ id: 'mock-board-1', name: 'Mock Board' }], total: 1 },
  TRELLO_GET_BOARD: { id: 'mock-board-1', name: 'Mock Board' },
  TRELLO_CREATE_BOARD: { id: 'mock-board-2', created: true },
  TRELLO_LIST_LISTS: { lists: [{ id: 'mock-list-1', name: 'Mock List' }], total: 1 },
  TRELLO_CREATE_LIST: { id: 'mock-list-2', created: true },
  TRELLO_LIST_CARDS: { cards: [{ id: 'mock-card-1', name: 'Mock Card' }], total: 1 },
  TRELLO_GET_CARD: { id: 'mock-card-1', name: 'Mock Card' },
  TRELLO_CREATE_CARD: { id: 'mock-card-2', created: true },
  TRELLO_UPDATE_CARD: { id: 'mock-card-1', updated: true },
  TRELLO_MOVE_CARD: { id: 'mock-card-1', moved: true },
  // Wave
  WAVE_LIST_INVOICES: { invoices: [{ id: 'mock-inv-1', amount: 100 }], total: 1 },
  WAVE_GET_INVOICE: { id: 'mock-inv-1', amount: 100 },
  WAVE_CREATE_INVOICE: { id: 'mock-inv-2', created: true },
  WAVE_UPDATE_INVOICE: { id: 'mock-inv-1', updated: true },
  WAVE_DELETE_INVOICE: { id: 'mock-inv-1', deleted: true },
  WAVE_LIST_CLIENTS: { clients: [{ id: 'mock-client-1', name: 'Mock Client' }], total: 1 },
  WAVE_GET_CLIENT: { id: 'mock-client-1', name: 'Mock Client' },
  WAVE_CREATE_CLIENT: { id: 'mock-client-2', created: true },
  WAVE_LIST_PAYMENTS: { payments: [{ id: 'mock-pay-1', amount: 100 }], total: 1 },
  WAVE_CREATE_PAYMENT: { id: 'mock-pay-2', created: true },
  // Basecamp
  BASECAMP_LIST_PROJECTS: { projects: [{ id: 'mock-bc-proj-1', name: 'Mock Project' }], total: 1 },
  BASECAMP_GET_PROJECT: { id: 'mock-bc-proj-1', name: 'Mock Project' },
  BASECAMP_CREATE_PROJECT: { id: 'mock-bc-proj-2', created: true },
  BASECAMP_LIST_TODOLISTS: { todolists: [{ id: 'mock-tdl-1', name: 'Mock Todolist' }], total: 1 },
  BASECAMP_CREATE_TODOLIST: { id: 'mock-tdl-2', created: true },
  BASECAMP_LIST_TODOS: { todos: [{ id: 'mock-todo-1', content: 'Mock Todo' }], total: 1 },
  BASECAMP_CREATE_TODO: { id: 'mock-todo-2', created: true },
  BASECAMP_COMPLETE_TODO: { id: 'mock-todo-1', completed: true },
  BASECAMP_LIST_MESSAGES: { messages: [{ id: 'mock-bc-msg-1', subject: 'Mock Message' }], total: 1 },
  BASECAMP_CREATE_MESSAGE: { id: 'mock-bc-msg-2', created: true },
  // Zoho
  ZOHO_LIST_INVOICES: { invoices: [{ id: 'mock-qb-inv-1', amount: 250 }], total: 1 },
  ZOHO_GET_INVOICE: { id: 'mock-qb-inv-1', amount: 250 },
  ZOHO_CREATE_INVOICE: { id: 'mock-qb-inv-2', created: true },
  ZOHO_LIST_CUSTOMERS: { customers: [{ id: 'mock-qb-cust-1', name: 'Mock Customer' }], total: 1 },
  ZOHO_GET_CUSTOMER: { id: 'mock-qb-cust-1', name: 'Mock Customer' },
  ZOHO_CREATE_CUSTOMER: { id: 'mock-qb-cust-2', created: true },
  ZOHO_LIST_EXPENSES: { expenses: [{ id: 'mock-qb-exp-1', amount: 50 }], total: 1 },
  ZOHO_CREATE_EXPENSE: { id: 'mock-qb-exp-2', created: true },
  ZOHO_LIST_ACCOUNTS: { accounts: [{ id: 'mock-qb-acc-1', name: 'Mock Account' }], total: 1 },
  ZOHO_GET_COMPANY_INFO: { id: 'mock-qb-company-1', name: 'Mock Company' },
};

/** Id xac dinh (deterministic) tu mot seed — de mock tra cung id moi lan. */
export function mockComposioV120DeterministicId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `mock-v120-${hash.toString(36)}`;
}

/** Tim toolkit chua slug tool ung vien; throw neu slug khong thuoc toolkit nao. */
export function resolveMockComposioV120Slug(toolkit: string, slug: string): ComposioV120MockToolkitDef {
  const def = findMockComposioV120Toolkit(toolkit);
  if (!def) throw new Error(`Unknown mock Composio v120 toolkit: ${toolkit}`);
  if (!def.candidateToolSlugs.includes(slug)) {
    throw new Error(`Unknown mock Composio v120 tool slug for ${toolkit}: ${slug}`);
  }
  return def;
}

/** Chay mot tool mock v120: tra du lieu mau + echo args, khong goi mang. */
export function executeMockComposioV120Tool(
  toolkit: string,
  slug: string,
  args: Record<string, unknown> = {},
): MockComposioV120Result {
  resolveMockComposioV120Slug(toolkit, slug);
  const sample = MOCK_SAMPLES[slug] ?? {};
  return {
    mock: true,
    live: false,
    toolkit,
    slug,
    data: { ...sample, echo: { ...args }, requestId: mockComposioV120DeterministicId(`${toolkit}:${slug}`) },
    note: MOCK_LIVE_NOTE,
  };
}

/** Executor dang class — de host/MCP bridge giu mot instance dung chung. */
export class MockComposioV120Executor {
  execute(toolkit: string, slug: string, args: Record<string, unknown> = {}): MockComposioV120Result {
    return executeMockComposioV120Tool(toolkit, slug, args);
  }

  listToolkits(): readonly ComposioV120MockToolkitDef[] {
    return COMPOSIO_V120_MOCK_TOOLKITS;
  }

  listSlugs(toolkit: string): string[] {
    const def = findMockComposioV120Toolkit(toolkit);
    if (!def) throw new Error(`Unknown mock Composio v120 toolkit: ${toolkit}`);
    return [...def.candidateToolSlugs];
  }

  /** Ten param ky vong cua mot slug (undefined = khong kiem tra). */
  paramNames(slug: string): readonly string[] | undefined {
    return mockComposioV120ParamNames(slug);
  }
}
