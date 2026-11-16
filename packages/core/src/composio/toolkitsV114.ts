/**
 * Composio toolkit MOCK v1.14 — 6 toolkit moi: Webflow, Pipedrive,
 * Chargebee, Xero, Eventbrite, SurveyMonkey (v1.14, Doi T4).
 *
 * MOCK-ONLY — CUNG TU THE v110/v111/v112:
 *
 * - Vault hien KHONG co Composio API key, nen KHONG co cach nao goi
 *   Composio that trong song nay. Moi thu trong file nay chay hoan
 *   toan local, khong goi mang, khong can key.
 * - Slug tool liet ke o day la SLUG UNG VIEN (candidate), dat theo
 *   quy uoc dat ten cua Composio (PREFIX_VERB_NOUN), KHONG PHAI slug
 *   da xac nhan live. 6 toolkit nay KHONG nam trong COMPOSIO_TOOLKITS
 *   (40 toolkit da xac nhan live van nguyen ven), ma song rieng o day
 *   duoi co `mockOnly: true, liveVerified: false`.
 * - De bat live sau nay (khi Huy da nhap key that vao Vault):
 *   1. Goi `GET /api/v3.1/tools?toolkit_slug=<slug>` voi key that,
 *      doi chieu tung slug ung vien voi slug that Composio tra ve.
 *   2. Slug nao khop thi chuyen toolkit do sang COMPOSIO_TOOLKITS
 *      (theo dung 10 slug/cap M7), cap nhat pin dem trong
 *      tests/composio-toolkits-a.test.mjs (40 -> 46 toolkit,
 *      400 -> 460 slug) — coordinator gop tinh lai.
 *   3. Slug nao khong khop thi sua/xoa, KHONG duoc giu slug bia
 *      trong catalog live (bai hoc SLACK_POST_MESSAGE v0.57).
 * - Mock executor (`MockComposioV114Executor`) tra du lieu mau xac
 *   dinh (deterministic, khong random, khong thoi gian thuc) cho
 *   tung slug, du de UI + agent loop + test chay end-to-end ma
 *   khong can key. Moi response deu mang `mock: true, live: false`
 *   + ghi chu can key that de chay live.
 * - Moi toolkit mang them `authKind` + `authNote`: cach xac thuc
 *   ma user se can khi bat live (OAuth2 qua Composio managed auth
 *   hay API key rieng), de UI hien dung huong dan ket noi.
 * - Chon 6 toolkit nay vi chung KHONG trung 40 toolkit live
 *   (gmail/github/slack/notion/jira/linear/asana/hubspot/...) va
 *   KHONG trung 6 toolkit mock v110 (figma/supabase/vercel/
 *   todoist/intercom/miro), 6 toolkit mock v111 (sentry/
 *   datadog/posthog/snowflake/amplitude/mixpanel) hay 6 toolkit
 *   mock v112 (grafana/elasticsearch/bigquery/clickhouse/
 *   launchdarkly/greenhouse): CMS + CRM + billing + ke toan +
 *   su kien + khao sat la nhom app integration con thieu cho
 *   nguoi dung kinh doanh nho (dung voi muc tieu san pham chung,
 *   khong phai cong cu niche).
 */

import type { AppDefinition } from '../apps/types';
import { composioAppId, composioToolNeedsApproval } from './toolkits';

/** Cach xac thuc cua mot toolkit khi bat live qua Composio. */
export type ComposioV114AuthKind = 'oauth2' | 'api-key' | 'oauth2-or-api-key';

/** Khai bao mot toolkit MOCK (chua xac nhan live). */
export interface ComposioV114MockToolkitDef {
  /** Slug toolkit Composio ung vien, vd 'webflow'. */
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
  authKind: ComposioV114AuthKind;
  /** Ghi chu xac thuc: user can chuan bi gi truoc khi ket noi live. */
  authNote: string;
  /** Luon true trong module nay: toolkit chi chay bang mock. */
  mockOnly: true;
  /** Luon false cho toi khi co nguoi doi chieu slug voi API that. */
  liveVerified: false;
}

/**
 * 6 toolkit mock — 10 slug ung vien moi toolkit (bang cap M7
 * `DEFAULT_APP_TOOL_CAP = 10`). Slug ung vien, CHUA xac nhan live.
 */
export const COMPOSIO_V114_MOCK_TOOLKITS: readonly ComposioV114MockToolkitDef[] = [
  {
    slug: 'webflow',
    label: 'Webflow (mock — via Composio)',
    icon: '🌐',
    description:
      '[MOCK] Doc/tạo site/collection/item Webflow qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'WEBFLOW_LIST_SITES',
      'WEBFLOW_GET_SITE',
      'WEBFLOW_LIST_COLLECTIONS',
      'WEBFLOW_GET_COLLECTION',
      'WEBFLOW_LIST_ITEMS',
      'WEBFLOW_GET_ITEM',
      'WEBFLOW_CREATE_ITEM',
      'WEBFLOW_UPDATE_ITEM',
      'WEBFLOW_DELETE_ITEM',
      'WEBFLOW_PUBLISH_SITE',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, chon workspace Webflow, khong can tu tao API token.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'pipedrive',
    label: 'Pipedrive (mock — via Composio)',
    icon: '🤝',
    description:
      '[MOCK] Doc/tạo deal/person/organization Pipedrive qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'PIPEDRIVE_LIST_DEALS',
      'PIPEDRIVE_GET_DEAL',
      'PIPEDRIVE_CREATE_DEAL',
      'PIPEDRIVE_UPDATE_DEAL',
      'PIPEDRIVE_LIST_PERSONS',
      'PIPEDRIVE_GET_PERSON',
      'PIPEDRIVE_CREATE_PERSON',
      'PIPEDRIVE_LIST_ORGANIZATIONS',
      'PIPEDRIVE_LIST_ACTIVITIES',
      'PIPEDRIVE_CREATE_ACTIVITY',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Pipedrive, khong can API token rieng.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'chargebee',
    label: 'Chargebee (mock — via Composio)',
    icon: '💳',
    description:
      '[MOCK] Doc/tạo subscription/invoice/customer Chargebee qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'CHARGEBEE_LIST_SUBSCRIPTIONS',
      'CHARGEBEE_GET_SUBSCRIPTION',
      'CHARGEBEE_CREATE_SUBSCRIPTION',
      'CHARGEBEE_CANCEL_SUBSCRIPTION',
      'CHARGEBEE_LIST_CUSTOMERS',
      'CHARGEBEE_GET_CUSTOMER',
      'CHARGEBEE_LIST_INVOICES',
      'CHARGEBEE_GET_INVOICE',
      'CHARGEBEE_LIST_PLANS',
      'CHARGEBEE_CREATE_CUSTOMER',
    ],
    authKind: 'api-key',
    authNote:
      'Live: can API key Chargebee (Settings → API Keys trong Chargebee dashboard) — Composio luu key nay trong managed auth cua user, open-bot khong bao gio thay key.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'xero',
    label: 'Xero (mock — via Composio)',
    icon: '📒',
    description:
      '[MOCK] Doc/tạo invoice/contact/payment Xero qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'XERO_LIST_INVOICES',
      'XERO_GET_INVOICE',
      'XERO_CREATE_INVOICE',
      'XERO_LIST_CONTACTS',
      'XERO_GET_CONTACT',
      'XERO_CREATE_CONTACT',
      'XERO_LIST_PAYMENTS',
      'XERO_LIST_ACCOUNTS',
      'XERO_GET_ACCOUNT',
      'XERO_LIST_ITEMS',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Xero va chon organisation, khong can client secret rieng.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'eventbrite',
    label: 'Eventbrite (mock — via Composio)',
    icon: '🎟️',
    description:
      '[MOCK] Doc/tạo event/attendee Eventbrite qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'EVENTBRITE_LIST_EVENTS',
      'EVENTBRITE_GET_EVENT',
      'EVENTBRITE_CREATE_EVENT',
      'EVENTBRITE_UPDATE_EVENT',
      'EVENTBRITE_LIST_ATTENDEES',
      'EVENTBRITE_GET_ATTENDEE',
      'EVENTBRITE_LIST_ORDERS',
      'EVENTBRITE_GET_ORDER',
      'EVENTBRITE_LIST_VENUES',
      'EVENTBRITE_CREATE_VENUE',
    ],
    authKind: 'oauth2-or-api-key',
    authNote:
      'Live: OAuth2 qua Composio la duong chinh; neu organisation dung private token thi co the dung API key (personal OAuth token) trong managed auth cua Composio.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'surveymonkey',
    label: 'SurveyMonkey (mock — via Composio)',
    icon: '📋',
    description:
      '[MOCK] Doc/tạo survey/response SurveyMonkey qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'SURVEYMONKEY_LIST_SURVEYS',
      'SURVEYMONKEY_GET_SURVEY',
      'SURVEYMONKEY_CREATE_SURVEY',
      'SURVEYMONKEY_LIST_RESPONSES',
      'SURVEYMONKEY_GET_RESPONSE',
      'SURVEYMONKEY_LIST_COLLECTORS',
      'SURVEYMONKEY_CREATE_COLLECTOR',
      'SURVEYMONKEY_LIST_QUESTIONS',
      'SURVEYMONKEY_GET_SURVEY_DETAILS',
      'SURVEYMONKEY_LIST_SURVEY_PAGES',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap SurveyMonkey, khong can API token rieng.',
    mockOnly: true,
    liveVerified: false,
  },
];

/** Tat ca slug ung vien cua 6 toolkit mock v114 (60 slug). */
export function mockComposioV114Slugs(): string[] {
  return COMPOSIO_V114_MOCK_TOOLKITS.flatMap((t) => [...t.candidateToolSlugs]);
}

/** Mot toolkit mock v114 theo slug, hoac undefined khi khong co. */
export function findMockComposioV114Toolkit(slug: string): ComposioV114MockToolkitDef | undefined {
  return COMPOSIO_V114_MOCK_TOOLKITS.find((t) => t.slug === slug);
}

/** true khi slug la slug tool ung vien cua mot toolkit mock v114. */
export function isMockComposioV114Slug(slug: string): boolean {
  return COMPOSIO_V114_MOCK_TOOLKITS.some((t) => t.candidateToolSlugs.includes(slug));
}

/** Tool mock co can approval khong — cung luat dong tu ghi nhu tool Composio that. */
export function mockComposioV114ToolNeedsApproval(slug: string): boolean {
  return composioToolNeedsApproval(slug);
}

/** App id cua mot toolkit mock: 'composio-<toolkit>' (cung quy uoc voi toolkit that). */
export function mockComposioV114AppId(toolkit: string): string {
  return composioAppId(toolkit);
}

/**
 * AppDefinition cho 6 toolkit mock — de UI bat/tat + liet ke tool
 * nhu toolkit that, nhung mo ta luon gan co [MOCK] de nguoi dung
 * khong nham voi ket noi live.
 */
export function createMockComposioV114AppDefinitions(): AppDefinition[] {
  return COMPOSIO_V114_MOCK_TOOLKITS.map((toolkit) => ({
    id: mockComposioV114AppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.candidateToolSlugs.map((slug) => ({
      name: slug,
      description: `[MOCK] Tool Composio ${slug} — slug ung vien chua xac nhan live, chi chay bang du lieu mau local.`,
      needsApproval: mockComposioV114ToolNeedsApproval(slug),
    })),
  }));
}

/** Tom tat catalogue mock v114: dem toolkit/slug + tach tool ghi/doc. */
export function summarizeMockComposioV114Catalogue(): {
  totalToolkits: number;
  totalSlugs: number;
  writeSlugs: number;
  readSlugs: number;
  byToolkit: { slug: string; total: number; write: number; read: number; authKind: ComposioV114AuthKind }[];
} {
  const byToolkit = COMPOSIO_V114_MOCK_TOOLKITS.map((t) => {
    const write = t.candidateToolSlugs.filter((s) => mockComposioV114ToolNeedsApproval(s)).length;
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
    totalToolkits: COMPOSIO_V114_MOCK_TOOLKITS.length,
    totalSlugs: mockComposioV114Slugs().length,
    writeSlugs,
    readSlugs: mockComposioV114Slugs().length - writeSlugs,
    byToolkit,
  };
}

// ---------------------------------------------------------------------------
// Mock executor — du lieu mau xac dinh cho tung slug
// ---------------------------------------------------------------------------

export interface MockComposioV114Result {
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
  // Webflow
  WEBFLOW_LIST_SITES: { sites: [{ id: 'mock-site-1', name: 'Mock Site' }], total: 1 },
  WEBFLOW_GET_SITE: { id: 'mock-site-1', name: 'Mock Site' },
  WEBFLOW_LIST_COLLECTIONS: { collections: [{ id: 'mock-coll-1', name: 'Mock Collection' }], total: 1 },
  WEBFLOW_GET_COLLECTION: { id: 'mock-coll-1', name: 'Mock Collection' },
  WEBFLOW_LIST_ITEMS: { items: [{ id: 'mock-item-1', name: 'Mock Item' }], total: 1 },
  WEBFLOW_GET_ITEM: { id: 'mock-item-1', name: 'Mock Item' },
  WEBFLOW_CREATE_ITEM: { id: 'mock-item-2', created: true },
  WEBFLOW_UPDATE_ITEM: { id: 'mock-item-1', updated: true },
  WEBFLOW_DELETE_ITEM: { id: 'mock-item-1', deleted: true },
  WEBFLOW_PUBLISH_SITE: { id: 'mock-site-1', published: true },
  // Pipedrive
  PIPEDRIVE_LIST_DEALS: { deals: [{ id: 'mock-deal-1', title: 'Mock Deal', value: 1000 }], total: 1 },
  PIPEDRIVE_GET_DEAL: { id: 'mock-deal-1', title: 'Mock Deal', value: 1000 },
  PIPEDRIVE_CREATE_DEAL: { id: 'mock-deal-2', created: true },
  PIPEDRIVE_UPDATE_DEAL: { id: 'mock-deal-1', updated: true },
  PIPEDRIVE_LIST_PERSONS: { persons: [{ id: 'mock-person-1', name: 'Mock Person' }], total: 1 },
  PIPEDRIVE_GET_PERSON: { id: 'mock-person-1', name: 'Mock Person' },
  PIPEDRIVE_CREATE_PERSON: { id: 'mock-person-2', created: true },
  PIPEDRIVE_LIST_ORGANIZATIONS: { organizations: [{ id: 'mock-org-1', name: 'Mock Org' }], total: 1 },
  PIPEDRIVE_LIST_ACTIVITIES: { activities: [{ id: 'mock-act-1', subject: 'Mock call' }], total: 1 },
  PIPEDRIVE_CREATE_ACTIVITY: { id: 'mock-act-2', created: true },
  // Chargebee
  CHARGEBEE_LIST_SUBSCRIPTIONS: { subscriptions: [{ id: 'mock-sub-1', status: 'active' }], total: 1 },
  CHARGEBEE_GET_SUBSCRIPTION: { id: 'mock-sub-1', status: 'active' },
  CHARGEBEE_CREATE_SUBSCRIPTION: { id: 'mock-sub-2', created: true },
  CHARGEBEE_CANCEL_SUBSCRIPTION: { id: 'mock-sub-1', cancelled: true },
  CHARGEBEE_LIST_CUSTOMERS: { customers: [{ id: 'mock-cust-1', name: 'Mock Customer' }], total: 1 },
  CHARGEBEE_GET_CUSTOMER: { id: 'mock-cust-1', name: 'Mock Customer' },
  CHARGEBEE_LIST_INVOICES: { invoices: [{ id: 'mock-inv-1', amount: 1000 }], total: 1 },
  CHARGEBEE_GET_INVOICE: { id: 'mock-inv-1', amount: 1000 },
  CHARGEBEE_LIST_PLANS: { plans: [{ id: 'mock-plan-1', name: 'Mock Plan' }], total: 1 },
  CHARGEBEE_CREATE_CUSTOMER: { id: 'mock-cust-2', created: true },
  // Xero
  XERO_LIST_INVOICES: { invoices: [{ id: 'mock-xinv-1', total: 1000 }], total: 1 },
  XERO_GET_INVOICE: { id: 'mock-xinv-1', total: 1000 },
  XERO_CREATE_INVOICE: { id: 'mock-xinv-2', created: true },
  XERO_LIST_CONTACTS: { contacts: [{ id: 'mock-xct-1', name: 'Mock Contact' }], total: 1 },
  XERO_GET_CONTACT: { id: 'mock-xct-1', name: 'Mock Contact' },
  XERO_CREATE_CONTACT: { id: 'mock-xct-2', created: true },
  XERO_LIST_PAYMENTS: { payments: [{ id: 'mock-xpay-1', amount: 1000 }], total: 1 },
  XERO_LIST_ACCOUNTS: { accounts: [{ id: 'mock-xacc-1', name: 'Mock Account' }], total: 1 },
  XERO_GET_ACCOUNT: { id: 'mock-xacc-1', name: 'Mock Account' },
  XERO_LIST_ITEMS: { items: [{ id: 'mock-xitem-1', name: 'Mock Item' }], total: 1 },
  // Eventbrite
  EVENTBRITE_LIST_EVENTS: { events: [{ id: 'mock-ev-1', name: 'Mock Event' }], total: 1 },
  EVENTBRITE_GET_EVENT: { id: 'mock-ev-1', name: 'Mock Event' },
  EVENTBRITE_CREATE_EVENT: { id: 'mock-ev-2', created: true },
  EVENTBRITE_UPDATE_EVENT: { id: 'mock-ev-1', updated: true },
  EVENTBRITE_LIST_ATTENDEES: { attendees: [{ id: 'mock-att-1', name: 'Mock Attendee' }], total: 1 },
  EVENTBRITE_GET_ATTENDEE: { id: 'mock-att-1', name: 'Mock Attendee' },
  EVENTBRITE_LIST_ORDERS: { orders: [{ id: 'mock-ord-1', total: 1000 }], total: 1 },
  EVENTBRITE_GET_ORDER: { id: 'mock-ord-1', total: 1000 },
  EVENTBRITE_LIST_VENUES: { venues: [{ id: 'mock-ven-1', name: 'Mock Venue' }], total: 1 },
  EVENTBRITE_CREATE_VENUE: { id: 'mock-ven-2', created: true },
  // SurveyMonkey
  SURVEYMONKEY_LIST_SURVEYS: { surveys: [{ id: 'mock-sur-1', title: 'Mock Survey' }], total: 1 },
  SURVEYMONKEY_GET_SURVEY: { id: 'mock-sur-1', title: 'Mock Survey' },
  SURVEYMONKEY_CREATE_SURVEY: { id: 'mock-sur-2', created: true },
  SURVEYMONKEY_LIST_RESPONSES: { responses: [{ id: 'mock-resp-1', complete: true }], total: 1 },
  SURVEYMONKEY_GET_RESPONSE: { id: 'mock-resp-1', complete: true },
  SURVEYMONKEY_LIST_COLLECTORS: { collectors: [{ id: 'mock-col-1', type: 'weblink' }], total: 1 },
  SURVEYMONKEY_CREATE_COLLECTOR: { id: 'mock-col-2', created: true },
  SURVEYMONKEY_LIST_QUESTIONS: { questions: [{ id: 'mock-q-1', text: 'Mock question?' }], total: 1 },
  SURVEYMONKEY_GET_SURVEY_DETAILS: { id: 'mock-sur-1', title: 'Mock Survey', questions: 1 },
  SURVEYMONKEY_LIST_SURVEY_PAGES: { pages: [{ id: 'mock-page-1', title: 'Mock Page' }], total: 1 },
};

/** Id xac dinh (deterministic) tu mot seed — de mock tra cung id moi lan. */
export function mockComposioV114DeterministicId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `mock-v114-${hash.toString(36)}`;
}

/** Tim toolkit chua slug tool ung vien; throw neu slug khong thuoc toolkit nao. */
export function resolveMockComposioV114Slug(toolkit: string, slug: string): ComposioV114MockToolkitDef {
  const def = findMockComposioV114Toolkit(toolkit);
  if (!def) throw new Error(`Unknown mock Composio v114 toolkit: ${toolkit}`);
  if (!def.candidateToolSlugs.includes(slug)) {
    throw new Error(`Unknown mock Composio v114 tool slug for ${toolkit}: ${slug}`);
  }
  return def;
}

/** Chay mot tool mock v114: tra du lieu mau + echo args, khong goi mang. */
export function executeMockComposioV114Tool(
  toolkit: string,
  slug: string,
  args: Record<string, unknown> = {},
): MockComposioV114Result {
  resolveMockComposioV114Slug(toolkit, slug);
  const sample = MOCK_SAMPLES[slug] ?? {};
  return {
    mock: true,
    live: false,
    toolkit,
    slug,
    data: { ...sample, echo: { ...args }, requestId: mockComposioV114DeterministicId(`${toolkit}:${slug}`) },
    note: MOCK_LIVE_NOTE,
  };
}

/** Executor dang class — de host/MCP bridge giu mot instance dung chung. */
export class MockComposioV114Executor {
  execute(toolkit: string, slug: string, args: Record<string, unknown> = {}): MockComposioV114Result {
    return executeMockComposioV114Tool(toolkit, slug, args);
  }

  listToolkits(): readonly ComposioV114MockToolkitDef[] {
    return COMPOSIO_V114_MOCK_TOOLKITS;
  }

  listSlugs(toolkit: string): string[] {
    const def = findMockComposioV114Toolkit(toolkit);
    if (!def) throw new Error(`Unknown mock Composio v114 toolkit: ${toolkit}`);
    return [...def.candidateToolSlugs];
  }
}
