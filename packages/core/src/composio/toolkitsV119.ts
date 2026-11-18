/**
 * Composio toolkit MOCK v1.19 — 3 toolkit moi: Wrike, BambooHR,
 * RingCentral (v1.19, Doi T4).
 *
 * MOCK-ONLY — CUNG TU THE v110/v111/v112/v114/v118:
 *
 * - Vault hien KHONG co Composio API key, nen KHONG co cach nao goi
 *   Composio that trong song nay. Moi thu trong file nay chay hoan
 *   toan local, khong goi mang, khong can key.
 * - Slug tool liet ke o day la SLUG UNG VIEN (candidate), dat theo
 *   quy uoc dat ten cua Composio (PREFIX_VERB_NOUN), KHONG PHAI slug
 *   da xac nhan live. 3 toolkit nay KHONG nam trong COMPOSIO_TOOLKITS
 *   (40 toolkit da xac nhan live van nguyen ven), ma song rieng o day
 *   duoi co `mockOnly: true, liveVerified: false`.
 * - De bat live sau nay (khi Huy da nhap key that vao Vault):
 *   1. Goi `GET /api/v3.1/tools?toolkit_slug=<slug>` voi key that,
 *      doi chieu tung slug ung vien voi slug that Composio tra ve.
 *   2. Slug nao khop thi chuyen toolkit do sang COMPOSIO_TOOLKITS
 *      (theo dung 10 slug/cap M7), cap nhat pin dem trong
 *      tests/composio-toolkits-a.test.mjs (40 -> 43 toolkit,
 *      400 -> 430 slug) — coordinator gop tinh lai.
 *   3. Slug nao khong khop thi sua/xoa, KHONG duoc giu slug bia
 *      trong catalog live (bai hoc SLACK_POST_MESSAGE v0.57).
 * - Mock executor (`MockComposioV119Executor`) tra du lieu mau xac
 *   dinh (deterministic, khong random, khong thoi gian thuc) cho
 *   tung slug, du de UI + agent loop + test chay end-to-end ma
 *   khong can key. Moi response deu mang `mock: true, live: false`
 *   + ghi chu can key that de chay live.
 * - Moi toolkit mang them `authKind` + `authNote`: cach xac thuc
 *   ma user se can khi bat live (OAuth2 qua Composio managed auth
 *   hay API key rieng), de UI hien dung huong dan ket noi.
 * - Chon 3 toolkit nay vi chung KHONG trung 40 toolkit live
 *   (gmail/github/slack/notion/jira/linear/asana/hubspot/...) va
 *   KHONG trung 6 toolkit mock v110 (figma/supabase/vercel/
 *   todoist/intercom/miro), 6 toolkit mock v111 (sentry/
 *   datadog/posthog/snowflake/amplitude/mixpanel), 6 toolkit mock
 *   v112 (grafana/elasticsearch/bigquery/clickhouse/
 *   launchdarkly/greenhouse), 6 toolkit mock v114 (webflow/
 *   pipedrive/chargebee/xero/eventbrite/surveymonkey) hay 3 toolkit
 *   mock v118 (canva/loom): quan ly du an nang cao
 *   (Wrike) + nhan su (BambooHR) + dien thoai/nhan tin doanh
 *   nghiep (RingCentral) la 3 nhom app integration con thieu cho
 *   doi nhom van phong — dung huong san pham chung, khong phai
 *   niche.
 */

import type { AppDefinition } from '../apps/types';
import { composioAppId, composioToolNeedsApproval } from './toolkits';

/** Cach xac thuc cua mot toolkit khi bat live qua Composio. */
export type ComposioV119AuthKind = 'oauth2' | 'api-key' | 'oauth2-or-api-key';

/** Khai bao mot toolkit MOCK (chua xac nhan live). */
export interface ComposioV119MockToolkitDef {
  /** Slug toolkit Composio ung vien, vd 'wrike'. */
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
  authKind: ComposioV119AuthKind;
  /** Ghi chu xac thuc: user can chuan bi gi truoc khi ket noi live. */
  authNote: string;
  /** Luon true trong module nay: toolkit chi chay bang mock. */
  mockOnly: true;
  /** Luon false cho toi khi co nguoi doi chieu slug voi API that. */
  liveVerified: false;
}

/**
 * 3 toolkit mock — 10 slug ung vien moi toolkit (bang cap M7
 * `DEFAULT_APP_TOOL_CAP = 10`). Slug ung vien, CHUA xac nhan live.
 */
export const COMPOSIO_V119_MOCK_TOOLKITS: readonly ComposioV119MockToolkitDef[] = [
  {
    slug: 'wrike',
    label: 'Wrike (mock — via Composio)',
    icon: '📋',
    description:
      '[MOCK] Doc/tạo task/du an Wrike qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'WRIKE_LIST_TASKS',
      'WRIKE_GET_TASK',
      'WRIKE_CREATE_TASK',
      'WRIKE_UPDATE_TASK',
      'WRIKE_DELETE_TASK',
      'WRIKE_LIST_PROJECTS',
      'WRIKE_GET_PROJECT',
      'WRIKE_CREATE_PROJECT',
      'WRIKE_LIST_FOLDERS',
      'WRIKE_LIST_COMMENTS',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Wrike va chon workspace, khong can API token rieng.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'bamboohr',
    label: 'BambooHR (mock — via Composio)',
    icon: '👥',
    description:
      '[MOCK] Doc/tạo nhan vien/nghi phep BambooHR qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'BAMBOOHR_LIST_EMPLOYEES',
      'BAMBOOHR_GET_EMPLOYEE',
      'BAMBOOHR_CREATE_EMPLOYEE',
      'BAMBOOHR_UPDATE_EMPLOYEE',
      'BAMBOOHR_LIST_TIME_OFF_REQUESTS',
      'BAMBOOHR_GET_TIME_OFF_REQUEST',
      'BAMBOOHR_CREATE_TIME_OFF_REQUEST',
      'BAMBOOHR_LIST_DEPARTMENTS',
      'BAMBOOHR_LIST_JOB_TITLES',
      'BAMBOOHR_GET_EMPLOYEE_PHOTO',
    ],
    authKind: 'api-key',
    authNote:
      'Live: ket noi bang API key BambooHR (lay trong BambooHR → API Keys, subdomain cong ty) — Composio luu key do, user khong can OAuth.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'ringcentral',
    label: 'RingCentral (mock — via Composio)',
    icon: '📞',
    description:
      '[MOCK] Doc/gui SMS/cuoc goi RingCentral qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'RINGCENTRAL_LIST_MESSAGES',
      'RINGCENTRAL_GET_MESSAGE',
      'RINGCENTRAL_SEND_SMS',
      'RINGCENTRAL_LIST_CALL_LOGS',
      'RINGCENTRAL_GET_CALL_LOG',
      'RINGCENTRAL_MAKE_CALL',
      'RINGCENTRAL_LIST_CONTACTS',
      'RINGCENTRAL_GET_CONTACT',
      'RINGCENTRAL_LIST_EXTENSIONS',
      'RINGCENTRAL_GET_EXTENSION_INFO',
    ],
    authKind: 'oauth2-or-api-key',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) hoac JWT/API key RingCentral — user chon mot trong hai cach trong Composio dashboard.',
    mockOnly: true,
    liveVerified: false,
  },
];

/** Tat ca slug ung vien cua 3 toolkit mock v119 (30 slug). */
export function mockComposioV119Slugs(): string[] {
  return COMPOSIO_V119_MOCK_TOOLKITS.flatMap((t) => [...t.candidateToolSlugs]);
}

/** Mot toolkit mock v119 theo slug, hoac undefined khi khong co. */
export function findMockComposioV119Toolkit(slug: string): ComposioV119MockToolkitDef | undefined {
  return COMPOSIO_V119_MOCK_TOOLKITS.find((t) => t.slug === slug);
}

/** true khi slug la slug tool ung vien cua mot toolkit mock v119. */
export function isMockComposioV119Slug(slug: string): boolean {
  return COMPOSIO_V119_MOCK_TOOLKITS.some((t) => t.candidateToolSlugs.includes(slug));
}

/** Tool mock co can approval khong — cung luat dong tu ghi nhu tool Composio that. */
export function mockComposioV119ToolNeedsApproval(slug: string): boolean {
  return composioToolNeedsApproval(slug);
}

/** App id cua mot toolkit mock: 'composio-<toolkit>' (cung quy uoc voi toolkit that). */
export function mockComposioV119AppId(toolkit: string): string {
  return composioAppId(toolkit);
}

/**
 * AppDefinition cho 3 toolkit mock — de UI bat/tat + liet ke tool
 * nhu toolkit that, nhung mo ta luon gan co [MOCK] de nguoi dung
 * khong nham voi ket noi live.
 */
export function createMockComposioV119AppDefinitions(): AppDefinition[] {
  return COMPOSIO_V119_MOCK_TOOLKITS.map((toolkit) => ({
    id: mockComposioV119AppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.candidateToolSlugs.map((slug) => ({
      name: slug,
      description: `[MOCK] Tool Composio ${slug} — slug ung vien chua xac nhan live, chi chay bang du lieu mau local.`,
      needsApproval: mockComposioV119ToolNeedsApproval(slug),
    })),
  }));
}

/** Tom tat catalogue mock v119: dem toolkit/slug + tach tool ghi/doc. */
export function summarizeMockComposioV119Catalogue(): {
  totalToolkits: number;
  totalSlugs: number;
  writeSlugs: number;
  readSlugs: number;
  byToolkit: { slug: string; total: number; write: number; read: number; authKind: ComposioV119AuthKind }[];
} {
  const byToolkit = COMPOSIO_V119_MOCK_TOOLKITS.map((t) => {
    const write = t.candidateToolSlugs.filter((s) => mockComposioV119ToolNeedsApproval(s)).length;
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
    totalToolkits: COMPOSIO_V119_MOCK_TOOLKITS.length,
    totalSlugs: mockComposioV119Slugs().length,
    writeSlugs,
    readSlugs: mockComposioV119Slugs().length - writeSlugs,
    byToolkit,
  };
}

// ---------------------------------------------------------------------------
// Mock executor — du lieu mau xac dinh cho tung slug
// ---------------------------------------------------------------------------

export interface MockComposioV119Result {
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
  // Wrike
  WRIKE_LIST_TASKS: { tasks: [{ id: 'mock-task-1', title: 'Mock Task' }], total: 1 },
  WRIKE_GET_TASK: { id: 'mock-task-1', title: 'Mock Task' },
  WRIKE_CREATE_TASK: { id: 'mock-task-2', created: true },
  WRIKE_UPDATE_TASK: { id: 'mock-task-1', updated: true },
  WRIKE_DELETE_TASK: { id: 'mock-task-1', deleted: true },
  WRIKE_LIST_PROJECTS: { projects: [{ id: 'mock-proj-1', title: 'Mock Project' }], total: 1 },
  WRIKE_GET_PROJECT: { id: 'mock-proj-1', title: 'Mock Project' },
  WRIKE_CREATE_PROJECT: { id: 'mock-proj-2', created: true },
  WRIKE_LIST_FOLDERS: { folders: [{ id: 'mock-folder-1', name: 'Mock Folder' }], total: 1 },
  WRIKE_LIST_COMMENTS: { comments: [{ id: 'mock-comment-1', text: 'Mock comment' }], total: 1 },
  // BambooHR
  BAMBOOHR_LIST_EMPLOYEES: { employees: [{ id: 'mock-emp-1', name: 'Mock Employee' }], total: 1 },
  BAMBOOHR_GET_EMPLOYEE: { id: 'mock-emp-1', name: 'Mock Employee' },
  BAMBOOHR_CREATE_EMPLOYEE: { id: 'mock-emp-2', created: true },
  BAMBOOHR_UPDATE_EMPLOYEE: { id: 'mock-emp-1', updated: true },
  BAMBOOHR_LIST_TIME_OFF_REQUESTS: { requests: [{ id: 'mock-tor-1', status: 'approved' }], total: 1 },
  BAMBOOHR_GET_TIME_OFF_REQUEST: { id: 'mock-tor-1', status: 'approved' },
  BAMBOOHR_CREATE_TIME_OFF_REQUEST: { id: 'mock-tor-2', created: true },
  BAMBOOHR_LIST_DEPARTMENTS: { departments: [{ id: 'mock-dept-1', name: 'Mock Department' }], total: 1 },
  BAMBOOHR_LIST_JOB_TITLES: { titles: [{ id: 'mock-title-1', name: 'Mock Title' }], total: 1 },
  BAMBOOHR_GET_EMPLOYEE_PHOTO: { id: 'mock-emp-1', photoUrl: 'https://example.invalid/mock-photo.png' },
  // RingCentral
  RINGCENTRAL_LIST_MESSAGES: { messages: [{ id: 'mock-msg-1', text: 'Mock message' }], total: 1 },
  RINGCENTRAL_GET_MESSAGE: { id: 'mock-msg-1', text: 'Mock message' },
  RINGCENTRAL_SEND_SMS: { id: 'mock-msg-2', sent: true },
  RINGCENTRAL_LIST_CALL_LOGS: { calls: [{ id: 'mock-call-1', durationSeconds: 60 }], total: 1 },
  RINGCENTRAL_GET_CALL_LOG: { id: 'mock-call-1', durationSeconds: 60 },
  RINGCENTRAL_MAKE_CALL: { id: 'mock-call-2', dialed: true },
  RINGCENTRAL_LIST_CONTACTS: { contacts: [{ id: 'mock-contact-1', name: 'Mock Contact' }], total: 1 },
  RINGCENTRAL_GET_CONTACT: { id: 'mock-contact-1', name: 'Mock Contact' },
  RINGCENTRAL_LIST_EXTENSIONS: { extensions: [{ id: 'mock-ext-1', name: 'Mock Extension' }], total: 1 },
  RINGCENTRAL_GET_EXTENSION_INFO: { id: 'mock-ext-1', name: 'Mock Extension' },
};

/** Id xac dinh (deterministic) tu mot seed — de mock tra cung id moi lan. */
export function mockComposioV119DeterministicId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `mock-v119-${hash.toString(36)}`;
}

/** Tim toolkit chua slug tool ung vien; throw neu slug khong thuoc toolkit nao. */
export function resolveMockComposioV119Slug(toolkit: string, slug: string): ComposioV119MockToolkitDef {
  const def = findMockComposioV119Toolkit(toolkit);
  if (!def) throw new Error(`Unknown mock Composio v119 toolkit: ${toolkit}`);
  if (!def.candidateToolSlugs.includes(slug)) {
    throw new Error(`Unknown mock Composio v119 tool slug for ${toolkit}: ${slug}`);
  }
  return def;
}

/** Chay mot tool mock v119: tra du lieu mau + echo args, khong goi mang. */
export function executeMockComposioV119Tool(
  toolkit: string,
  slug: string,
  args: Record<string, unknown> = {},
): MockComposioV119Result {
  resolveMockComposioV119Slug(toolkit, slug);
  const sample = MOCK_SAMPLES[slug] ?? {};
  return {
    mock: true,
    live: false,
    toolkit,
    slug,
    data: { ...sample, echo: { ...args }, requestId: mockComposioV119DeterministicId(`${toolkit}:${slug}`) },
    note: MOCK_LIVE_NOTE,
  };
}

/** Executor dang class — de host/MCP bridge giu mot instance dung chung. */
export class MockComposioV119Executor {
  execute(toolkit: string, slug: string, args: Record<string, unknown> = {}): MockComposioV119Result {
    return executeMockComposioV119Tool(toolkit, slug, args);
  }

  listToolkits(): readonly ComposioV119MockToolkitDef[] {
    return COMPOSIO_V119_MOCK_TOOLKITS;
  }

  listSlugs(toolkit: string): string[] {
    const def = findMockComposioV119Toolkit(toolkit);
    if (!def) throw new Error(`Unknown mock Composio v119 toolkit: ${toolkit}`);
    return [...def.candidateToolSlugs];
  }
}
