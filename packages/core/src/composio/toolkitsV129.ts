/**
 * Composio toolkit MOCK v1.29 — 4 toolkit moi: Smartsheet, ServiceNow,
 * Klaviyo, OneDrive (v1.29, Doi T4 — Composio v6).
 *
 * MOCK-ONLY — CUNG TU THE v110/v111/v112/v114/v118/v119/v120:
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
 * - Mock executor (`MockComposioV129Executor`) tra du lieu mau xac
 *   dinh (deterministic, khong random, khong thoi gian thuc) cho
 *   tung slug, du de UI + agent loop + test chay end-to-end ma
 *   khong can key. Moi response deu mang `mock: true, live: false`
 *   + ghi chu can key that de chay live.
 * - Moi toolkit mang them `authKind` + `authNote`: cach xac thuc
 *   ma user se can khi bat live (OAuth2 qua Composio managed auth
 *   hay API key rieng), de UI hien dung huong dan ket noi.
 * - Moi slug ung vien kem theo danh sach ten param ky vong
 *   (`paramNames`) — de sandbox v129 + app binding v129 kiem tra
 *   param cua user truoc khi luu/chay (param la thi bao loi ngay,
 *   khong doi toi luc chay moi biet).
 * - Chon 4 toolkit nay vi chung KHONG trung 40 toolkit live
 *   (gmail/github/slack/notion/jira/linear/asana/hubspot/zoom/
 *   salesforce/zendesk/airtable/monday/clickup/dropbox/outlook/
 *   stripe/shopify/box/confluence/gitlab/calendly/mailchimp/
 *   twilio/googledocs/youtube/linkedin/reddit/whatsapp/pagerduty/
 *   typeform/sendgrid/bitbucket/freshdesk/...) va KHONG trung
 *   6 toolkit mock v110 (figma/supabase/vercel/todoist/intercom/
 *   miro), 6 toolkit mock v111 (sentry/datadog/posthog/snowflake/
 *   amplitude/mixpanel), 6 toolkit mock v112 (grafana/elasticsearch/
 *   bigquery/clickhouse/launchdarkly/greenhouse), 6 toolkit mock
 *   v114 (webflow/pipedrive/chargebee/xero/eventbrite/
 *   surveymonkey), 3 toolkit mock v118 (canva/docusign/loom),
 *   3 toolkit mock v119 (wrike/bamboohr/ringcentral) hay 4 toolkit
 *   mock v120 (trello/wave/basecamp/zoho): quan ly
 *   sheet cong viec (Smartsheet) + ITSM ticket (ServiceNow) +
 *   marketing automation (Klaviyo) + file ca nhan (OneDrive) la
 *   4 nhom app integration con thieu cho doi nhom van phong —
 *   dung huong san pham chung, khong phai niche. Luu y:
 *   OneDrive KHAC Google Drive (live) va Dropbox/Box (live);
 *   Smartsheet KHAC Airtable/Monday/ClickUp (live) va Wrike
 *   (mock v119); Klaviyo KHAC Mailchimp/SendGrid (live).
 */

import type { AppDefinition } from '../apps/types';
import { composioAppId, composioToolNeedsApproval } from './toolkits';

/** Cach xac thuc cua mot toolkit khi bat live qua Composio. */
export type ComposioV129AuthKind = 'oauth2' | 'api-key' | 'oauth2-or-api-key';

/** Khai bao mot toolkit MOCK (chua xac nhan live). */
export interface ComposioV129MockToolkitDef {
  /** Slug toolkit Composio ung vien, vd 'smartsheet'. */
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
  authKind: ComposioV129AuthKind;
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
export const COMPOSIO_V129_MOCK_TOOLKITS: readonly ComposioV129MockToolkitDef[] = [
  {
    slug: 'smartsheet',
    label: 'Smartsheet (mock — via Composio)',
    icon: '📊',
    description:
      '[MOCK] Doc/tạo sheet/row/report Smartsheet qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'SMARTSHEET_LIST_SHEETS',
      'SMARTSHEET_GET_SHEET',
      'SMARTSHEET_CREATE_SHEET',
      'SMARTSHEET_LIST_ROWS',
      'SMARTSHEET_GET_ROW',
      'SMARTSHEET_CREATE_ROW',
      'SMARTSHEET_UPDATE_ROW',
      'SMARTSHEET_DELETE_ROW',
      'SMARTSHEET_LIST_REPORTS',
      'SMARTSHEET_SHARE_SHEET',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Smartsheet va cap quyen doc/ghi sheet, khong can API token rieng.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'servicenow',
    label: 'ServiceNow (mock — via Composio)',
    icon: '🎫',
    description:
      '[MOCK] Doc/tạo incident/request ServiceNow qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'SERVICENOW_LIST_INCIDENTS',
      'SERVICENOW_GET_INCIDENT',
      'SERVICENOW_CREATE_INCIDENT',
      'SERVICENOW_UPDATE_INCIDENT',
      'SERVICENOW_RESOLVE_INCIDENT',
      'SERVICENOW_LIST_REQUESTS',
      'SERVICENOW_CREATE_REQUEST',
      'SERVICENOW_GET_REQUEST',
      'SERVICENOW_LIST_USERS',
      'SERVICENOW_ADD_COMMENT',
    ],
    authKind: 'oauth2-or-api-key',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) neu instance cho phep, hoac API key rieng (basic auth username/password cua ServiceNow instance) — user can ten instance (vd mycompany.service-now.com) truoc khi ket noi.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'klaviyo',
    label: 'Klaviyo (mock — via Composio)',
    icon: '✉️',
    description:
      '[MOCK] Doc/tạo list/profile/campaign Klaviyo qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'KLAVIYO_LIST_LISTS',
      'KLAVIYO_GET_LIST',
      'KLAVIYO_CREATE_LIST',
      'KLAVIYO_LIST_PROFILES',
      'KLAVIYO_GET_PROFILE',
      'KLAVIYO_CREATE_PROFILE',
      'KLAVIYO_SUBSCRIBE_PROFILE',
      'KLAVIYO_LIST_CAMPAIGNS',
      'KLAVIYO_CREATE_CAMPAIGN',
      'KLAVIYO_SEND_CAMPAIGN',
    ],
    authKind: 'api-key',
    authNote:
      'Live: ket noi bang API key rieng (Klaviyo private API key, bat dau bang pk_) — user tao key trong Klaviyo Settings → API Keys roi dan vao Composio; khong dung OAuth2.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'onedrive',
    label: 'OneDrive (mock — via Composio)',
    icon: '☁️',
    description:
      '[MOCK] Doc/tạo file/thu muc OneDrive qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'ONEDRIVE_LIST_FILES',
      'ONEDRIVE_GET_FILE',
      'ONEDRIVE_UPLOAD_FILE',
      'ONEDRIVE_DOWNLOAD_FILE',
      'ONEDRIVE_DELETE_FILE',
      'ONEDRIVE_CREATE_FOLDER',
      'ONEDRIVE_LIST_FOLDERS',
      'ONEDRIVE_MOVE_FILE',
      'ONEDRIVE_SHARE_FILE',
      'ONEDRIVE_SEARCH_FILES',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap tai khoan Microsoft va cap quyen doc/ghi OneDrive.',
    mockOnly: true,
    liveVerified: false,
  },
];

/**
 * Ten param ky vong cua tung slug ung vien v129 (de sandbox v129
 * + app binding v129 kiem tra param cua user truoc khi luu/chay).
 * Day la DANH SACH TEN — khong phai schema day du (kieu du lieu do
 * live API quyet dinh sau). Slug nao khong co trong bang thi chap
 * nhan bat ky param nao (khong kiem tra).
 */
export const COMPOSIO_V129_MOCK_TOOL_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  SMARTSHEET_LIST_SHEETS: ['limit'],
  SMARTSHEET_GET_SHEET: ['sheetId'],
  SMARTSHEET_CREATE_SHEET: ['name', 'columns'],
  SMARTSHEET_LIST_ROWS: ['sheetId', 'limit'],
  SMARTSHEET_GET_ROW: ['sheetId', 'rowId'],
  SMARTSHEET_CREATE_ROW: ['sheetId', 'cells'],
  SMARTSHEET_UPDATE_ROW: ['sheetId', 'rowId', 'cells'],
  SMARTSHEET_DELETE_ROW: ['sheetId', 'rowId'],
  SMARTSHEET_LIST_REPORTS: ['limit'],
  SMARTSHEET_SHARE_SHEET: ['sheetId', 'email', 'accessLevel'],
  SERVICENOW_LIST_INCIDENTS: ['state', 'limit'],
  SERVICENOW_GET_INCIDENT: ['incidentId'],
  SERVICENOW_CREATE_INCIDENT: ['shortDescription', 'description', 'urgency'],
  SERVICENOW_UPDATE_INCIDENT: ['incidentId', 'state', 'workNotes'],
  SERVICENOW_RESOLVE_INCIDENT: ['incidentId', 'resolutionNotes'],
  SERVICENOW_LIST_REQUESTS: ['state', 'limit'],
  SERVICENOW_CREATE_REQUEST: ['shortDescription', 'description'],
  SERVICENOW_GET_REQUEST: ['requestId'],
  SERVICENOW_LIST_USERS: ['limit'],
  SERVICENOW_ADD_COMMENT: ['incidentId', 'comment'],
  KLAVIYO_LIST_LISTS: ['limit'],
  KLAVIYO_GET_LIST: ['listId'],
  KLAVIYO_CREATE_LIST: ['name'],
  KLAVIYO_LIST_PROFILES: ['listId', 'limit'],
  KLAVIYO_GET_PROFILE: ['profileId'],
  KLAVIYO_CREATE_PROFILE: ['email', 'firstName', 'lastName'],
  KLAVIYO_SUBSCRIBE_PROFILE: ['listId', 'email'],
  KLAVIYO_LIST_CAMPAIGNS: ['status', 'limit'],
  KLAVIYO_CREATE_CAMPAIGN: ['name', 'listId'],
  KLAVIYO_SEND_CAMPAIGN: ['campaignId'],
  ONEDRIVE_LIST_FILES: ['folderId', 'limit'],
  ONEDRIVE_GET_FILE: ['fileId'],
  ONEDRIVE_UPLOAD_FILE: ['folderId', 'fileName', 'content'],
  ONEDRIVE_DOWNLOAD_FILE: ['fileId'],
  ONEDRIVE_DELETE_FILE: ['fileId'],
  ONEDRIVE_CREATE_FOLDER: ['parentId', 'name'],
  ONEDRIVE_LIST_FOLDERS: ['parentId', 'limit'],
  ONEDRIVE_MOVE_FILE: ['fileId', 'folderId'],
  ONEDRIVE_SHARE_FILE: ['fileId', 'email'],
  ONEDRIVE_SEARCH_FILES: ['query', 'limit'],
};

/** Tat ca slug ung vien cua 4 toolkit mock v129 (40 slug). */
export function mockComposioV129Slugs(): string[] {
  return COMPOSIO_V129_MOCK_TOOLKITS.flatMap((t) => [...t.candidateToolSlugs]);
}

/** Mot toolkit mock v129 theo slug, hoac undefined khi khong co. */
export function findMockComposioV129Toolkit(slug: string): ComposioV129MockToolkitDef | undefined {
  return COMPOSIO_V129_MOCK_TOOLKITS.find((t) => t.slug === slug);
}

/** true khi slug la slug tool ung vien cua mot toolkit mock v129. */
export function isMockComposioV129Slug(slug: string): boolean {
  return COMPOSIO_V129_MOCK_TOOLKITS.some((t) => t.candidateToolSlugs.includes(slug));
}

/** Tool mock co can approval khong — cung luat dong tu ghi nhu tool Composio that. */
export function mockComposioV129ToolNeedsApproval(slug: string): boolean {
  return composioToolNeedsApproval(slug);
}

/** App id cua mot toolkit mock: 'composio-<toolkit>' (cung quy uoc voi toolkit that). */
export function mockComposioV129AppId(toolkit: string): string {
  return composioAppId(toolkit);
}

/** Ten param ky vong cua mot slug (undefined = khong co bang, khong kiem tra). */
export function mockComposioV129ParamNames(slug: string): readonly string[] | undefined {
  return COMPOSIO_V129_MOCK_TOOL_PARAM_NAMES[slug];
}

/**
 * Kiem tra param cua mot lan goi mock v129: tra danh sach ten param
 * la (khong co trong bang paramNames cua slug). Tra [] khi hop le
 * hoac khi slug khong co bang (khong kiem tra).
 */
export function validateMockComposioV129Params(
  slug: string,
  args: Record<string, unknown>,
): string[] {
  const expected = mockComposioV129ParamNames(slug);
  if (!expected) return [];
  return Object.keys(args).filter((name) => !expected.includes(name));
}

/**
 * AppDefinition cho 4 toolkit mock — de UI bat/tat + liet ke tool
 * nhu toolkit that, nhung mo ta luon gan co [MOCK] de nguoi dung
 * khong nham voi ket noi live.
 */
export function createMockComposioV129AppDefinitions(): AppDefinition[] {
  return COMPOSIO_V129_MOCK_TOOLKITS.map((toolkit) => ({
    id: mockComposioV129AppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.candidateToolSlugs.map((slug) => ({
      name: slug,
      description: `[MOCK] Tool Composio ${slug} — slug ung vien chua xac nhan live, chi chay bang du lieu mau local.`,
      needsApproval: mockComposioV129ToolNeedsApproval(slug),
    })),
  }));
}

/** Tom tat catalogue mock v129: dem toolkit/slug + tach tool ghi/doc. */
export function summarizeMockComposioV129Catalogue(): {
  totalToolkits: number;
  totalSlugs: number;
  writeSlugs: number;
  readSlugs: number;
  byToolkit: { slug: string; total: number; write: number; read: number; authKind: ComposioV129AuthKind }[];
} {
  const byToolkit = COMPOSIO_V129_MOCK_TOOLKITS.map((t) => {
    const write = t.candidateToolSlugs.filter((s) => mockComposioV129ToolNeedsApproval(s)).length;
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
    totalToolkits: COMPOSIO_V129_MOCK_TOOLKITS.length,
    totalSlugs: mockComposioV129Slugs().length,
    writeSlugs,
    readSlugs: mockComposioV129Slugs().length - writeSlugs,
    byToolkit,
  };
}

// ---------------------------------------------------------------------------
// Mock executor — du lieu mau xac dinh cho tung slug
// ---------------------------------------------------------------------------

export interface MockComposioV129Result {
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
  // Smartsheet
  SMARTSHEET_LIST_SHEETS: { sheets: [{ id: 'mock-sheet-1', name: 'Mock Sheet' }], total: 1 },
  SMARTSHEET_GET_SHEET: { id: 'mock-sheet-1', name: 'Mock Sheet' },
  SMARTSHEET_CREATE_SHEET: { id: 'mock-sheet-2', created: true },
  SMARTSHEET_LIST_ROWS: { rows: [{ id: 'mock-row-1', cells: [] }], total: 1 },
  SMARTSHEET_GET_ROW: { id: 'mock-row-1', cells: [] },
  SMARTSHEET_CREATE_ROW: { id: 'mock-row-2', created: true },
  SMARTSHEET_UPDATE_ROW: { id: 'mock-row-1', updated: true },
  SMARTSHEET_DELETE_ROW: { id: 'mock-row-1', deleted: true },
  SMARTSHEET_LIST_REPORTS: { reports: [{ id: 'mock-report-1', name: 'Mock Report' }], total: 1 },
  SMARTSHEET_SHARE_SHEET: { id: 'mock-sheet-1', shared: true },
  // ServiceNow
  SERVICENOW_LIST_INCIDENTS: { incidents: [{ id: 'mock-inc-1', state: 'new' }], total: 1 },
  SERVICENOW_GET_INCIDENT: { id: 'mock-inc-1', state: 'new' },
  SERVICENOW_CREATE_INCIDENT: { id: 'mock-inc-2', created: true },
  SERVICENOW_UPDATE_INCIDENT: { id: 'mock-inc-1', updated: true },
  SERVICENOW_RESOLVE_INCIDENT: { id: 'mock-inc-1', resolved: true },
  SERVICENOW_LIST_REQUESTS: { requests: [{ id: 'mock-req-1', state: 'open' }], total: 1 },
  SERVICENOW_CREATE_REQUEST: { id: 'mock-req-2', created: true },
  SERVICENOW_GET_REQUEST: { id: 'mock-req-1', state: 'open' },
  SERVICENOW_LIST_USERS: { users: [{ id: 'mock-sn-user-1', name: 'Mock User' }], total: 1 },
  SERVICENOW_ADD_COMMENT: { id: 'mock-inc-1', commented: true },
  // Klaviyo
  KLAVIYO_LIST_LISTS: { lists: [{ id: 'mock-kl-list-1', name: 'Mock List' }], total: 1 },
  KLAVIYO_GET_LIST: { id: 'mock-kl-list-1', name: 'Mock List' },
  KLAVIYO_CREATE_LIST: { id: 'mock-kl-list-2', created: true },
  KLAVIYO_LIST_PROFILES: { profiles: [{ id: 'mock-kl-prof-1', email: 'mock@example.com' }], total: 1 },
  KLAVIYO_GET_PROFILE: { id: 'mock-kl-prof-1', email: 'mock@example.com' },
  KLAVIYO_CREATE_PROFILE: { id: 'mock-kl-prof-2', created: true },
  KLAVIYO_SUBSCRIBE_PROFILE: { id: 'mock-kl-prof-1', subscribed: true },
  KLAVIYO_LIST_CAMPAIGNS: { campaigns: [{ id: 'mock-kl-camp-1', name: 'Mock Campaign' }], total: 1 },
  KLAVIYO_CREATE_CAMPAIGN: { id: 'mock-kl-camp-2', created: true },
  KLAVIYO_SEND_CAMPAIGN: { id: 'mock-kl-camp-1', sent: true },
  // OneDrive
  ONEDRIVE_LIST_FILES: { files: [{ id: 'mock-od-file-1', name: 'Mock File' }], total: 1 },
  ONEDRIVE_GET_FILE: { id: 'mock-od-file-1', name: 'Mock File' },
  ONEDRIVE_UPLOAD_FILE: { id: 'mock-od-file-2', created: true },
  ONEDRIVE_DOWNLOAD_FILE: { id: 'mock-od-file-1', downloaded: true },
  ONEDRIVE_DELETE_FILE: { id: 'mock-od-file-1', deleted: true },
  ONEDRIVE_CREATE_FOLDER: { id: 'mock-od-folder-2', created: true },
  ONEDRIVE_LIST_FOLDERS: { folders: [{ id: 'mock-od-folder-1', name: 'Mock Folder' }], total: 1 },
  ONEDRIVE_MOVE_FILE: { id: 'mock-od-file-1', moved: true },
  ONEDRIVE_SHARE_FILE: { id: 'mock-od-file-1', shared: true },
  ONEDRIVE_SEARCH_FILES: { files: [{ id: 'mock-od-file-1', name: 'Mock File' }], total: 1 },
};

/** Id xac dinh (deterministic) tu mot seed — de mock tra cung id moi lan. */
export function mockComposioV129DeterministicId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `mock-v129-${hash.toString(36)}`;
}

/** Tim toolkit chua slug tool ung vien; throw neu slug khong thuoc toolkit nao. */
export function resolveMockComposioV129Slug(toolkit: string, slug: string): ComposioV129MockToolkitDef {
  const def = findMockComposioV129Toolkit(toolkit);
  if (!def) throw new Error(`Unknown mock Composio v129 toolkit: ${toolkit}`);
  if (!def.candidateToolSlugs.includes(slug)) {
    throw new Error(`Unknown mock Composio v129 tool slug for ${toolkit}: ${slug}`);
  }
  return def;
}

/** Chay mot tool mock v129: tra du lieu mau + echo args, khong goi mang. */
export function executeMockComposioV129Tool(
  toolkit: string,
  slug: string,
  args: Record<string, unknown> = {},
): MockComposioV129Result {
  resolveMockComposioV129Slug(toolkit, slug);
  const sample = MOCK_SAMPLES[slug] ?? {};
  return {
    mock: true,
    live: false,
    toolkit,
    slug,
    data: { ...sample, echo: { ...args }, requestId: mockComposioV129DeterministicId(`${toolkit}:${slug}`) },
    note: MOCK_LIVE_NOTE,
  };
}

/** Executor dang class — de host/MCP bridge giu mot instance dung chung. */
export class MockComposioV129Executor {
  execute(toolkit: string, slug: string, args: Record<string, unknown> = {}): MockComposioV129Result {
    return executeMockComposioV129Tool(toolkit, slug, args);
  }

  listToolkits(): readonly ComposioV129MockToolkitDef[] {
    return COMPOSIO_V129_MOCK_TOOLKITS;
  }

  listSlugs(toolkit: string): string[] {
    const def = findMockComposioV129Toolkit(toolkit);
    if (!def) throw new Error(`Unknown mock Composio v129 toolkit: ${toolkit}`);
    return [...def.candidateToolSlugs];
  }

  /** Ten param ky vong cua mot slug (undefined = khong kiem tra). */
  paramNames(slug: string): readonly string[] | undefined {
    return mockComposioV129ParamNames(slug);
  }

  /** Param la cua mot lan goi (rong = hop le). */
  unknownParams(slug: string, args: Record<string, unknown>): string[] {
    return validateMockComposioV129Params(slug, args);
  }
}
