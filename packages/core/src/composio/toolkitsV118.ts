/**
 * Composio toolkit MOCK v1.18 — 3 toolkit moi: Canva, PandaDoc, Loom
 * (v1.18, Doi T4).
 *
 * MOCK-ONLY — CUNG TU THE v110/v111/v112/v114:
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
 * - Mock executor (`MockComposioV118Executor`) tra du lieu mau xac
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
 *   pipedrive/chargebee/xero/eventbrite/surveymonkey) hay 6 toolkit
 *   mock v116 fleetV13 (docusign/freshbooks/gong/lever/quickbooks/
 *   resend). FIX v1.18: ban dau T4 chon 'docusign' nhung slug nay da
 *   co o fleetV13 v116 nen doi thanh 'pandadoc' de khong trung slug.
 *   Thiet ke (Canva) + ky so tai lieu (PandaDoc) + nhan video (Loom)
 *   nhom app integration con thieu cho nguoi dung lam noi dung va
 *   van phong nho — dung huong san pham chung, khong phai niche.
 *   Luu y: `microsoftteams`/`teams` KHONG them duoc — Composio tra
 *   0 tool cho ca 2 slug (ghi trong toolkits.ts), nen nhom messaging
 *   o day lay Loom (video message) thay vi Teams.
 */

import type { AppDefinition } from '../apps/types';
import { composioAppId, composioToolNeedsApproval } from './toolkits';

/** Cach xac thuc cua mot toolkit khi bat live qua Composio. */
export type ComposioV118AuthKind = 'oauth2' | 'api-key' | 'oauth2-or-api-key';

/** Khai bao mot toolkit MOCK (chua xac nhan live). */
export interface ComposioV118MockToolkitDef {
  /** Slug toolkit Composio ung vien, vd 'canva'. */
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
  authKind: ComposioV118AuthKind;
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
export const COMPOSIO_V118_MOCK_TOOLKITS: readonly ComposioV118MockToolkitDef[] = [
  {
    slug: 'canva',
    label: 'Canva (mock — via Composio)',
    icon: '🎨',
    description:
      '[MOCK] Doc/tạo thiet ke/brand template Canva qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'CANVA_LIST_DESIGNS',
      'CANVA_GET_DESIGN',
      'CANVA_CREATE_DESIGN',
      'CANVA_UPDATE_DESIGN',
      'CANVA_DELETE_DESIGN',
      'CANVA_LIST_BRAND_TEMPLATES',
      'CANVA_GET_BRAND_TEMPLATE',
      'CANVA_CREATE_BRAND_TEMPLATE',
      'CANVA_LIST_FOLDERS',
      'CANVA_EXPORT_DESIGN',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Canva va chon team, khong can API token rieng.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'pandadoc',
    label: 'PandaDoc (mock — via Composio)',
    icon: '✍️',
    description:
      '[MOCK] Doc/tạo document/tai lieu ky so PandaDoc qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'PANDADOC_LIST_DOCUMENTS',
      'PANDADOC_GET_DOCUMENT',
      'PANDADOC_CREATE_DOCUMENT',
      'PANDADOC_SEND_DOCUMENT',
      'PANDADOC_LIST_RECIPIENTS',
      'PANDADOC_GET_RECIPIENT_STATUS',
      'PANDADOC_LIST_TEMPLATES',
      'PANDADOC_GET_TEMPLATE',
      'PANDADOC_DOWNLOAD_DOCUMENT',
      'PANDADOC_VOID_DOCUMENT',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap PandaDoc va chon account, khong can integration key rieng.',
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'loom',
    label: 'Loom (mock — via Composio)',
    icon: '🎥',
    description:
      '[MOCK] Doc/tạo video/comment Loom qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'LOOM_LIST_VIDEOS',
      'LOOM_GET_VIDEO',
      'LOOM_CREATE_VIDEO',
      'LOOM_UPDATE_VIDEO',
      'LOOM_DELETE_VIDEO',
      'LOOM_LIST_COMMENTS',
      'LOOM_CREATE_COMMENT',
      'LOOM_LIST_FOLDERS',
      'LOOM_SHARE_VIDEO',
      'LOOM_GET_VIDEO_ANALYTICS',
    ],
    authKind: 'oauth2',
    authNote:
      'Live: ket noi bang OAuth2 qua Composio (managed auth) — user bam Connect trong Composio dashboard, dang nhap Loom va chon workspace, khong can API token rieng.',
    mockOnly: true,
    liveVerified: false,
  },
];

/** Tat ca slug ung vien cua 3 toolkit mock v118 (30 slug). */
export function mockComposioV118Slugs(): string[] {
  return COMPOSIO_V118_MOCK_TOOLKITS.flatMap((t) => [...t.candidateToolSlugs]);
}

/** Mot toolkit mock v118 theo slug, hoac undefined khi khong co. */
export function findMockComposioV118Toolkit(slug: string): ComposioV118MockToolkitDef | undefined {
  return COMPOSIO_V118_MOCK_TOOLKITS.find((t) => t.slug === slug);
}

/** true khi slug la slug tool ung vien cua mot toolkit mock v118. */
export function isMockComposioV118Slug(slug: string): boolean {
  return COMPOSIO_V118_MOCK_TOOLKITS.some((t) => t.candidateToolSlugs.includes(slug));
}

/** Tool mock co can approval khong — cung luat dong tu ghi nhu tool Composio that. */
export function mockComposioV118ToolNeedsApproval(slug: string): boolean {
  return composioToolNeedsApproval(slug);
}

/** App id cua mot toolkit mock: 'composio-<toolkit>' (cung quy uoc voi toolkit that). */
export function mockComposioV118AppId(toolkit: string): string {
  return composioAppId(toolkit);
}

/**
 * AppDefinition cho 3 toolkit mock — de UI bat/tat + liet ke tool
 * nhu toolkit that, nhung mo ta luon gan co [MOCK] de nguoi dung
 * khong nham voi ket noi live.
 */
export function createMockComposioV118AppDefinitions(): AppDefinition[] {
  return COMPOSIO_V118_MOCK_TOOLKITS.map((toolkit) => ({
    id: mockComposioV118AppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.candidateToolSlugs.map((slug) => ({
      name: slug,
      description: `[MOCK] Tool Composio ${slug} — slug ung vien chua xac nhan live, chi chay bang du lieu mau local.`,
      needsApproval: mockComposioV118ToolNeedsApproval(slug),
    })),
  }));
}

/** Tom tat catalogue mock v118: dem toolkit/slug + tach tool ghi/doc. */
export function summarizeMockComposioV118Catalogue(): {
  totalToolkits: number;
  totalSlugs: number;
  writeSlugs: number;
  readSlugs: number;
  byToolkit: { slug: string; total: number; write: number; read: number; authKind: ComposioV118AuthKind }[];
} {
  const byToolkit = COMPOSIO_V118_MOCK_TOOLKITS.map((t) => {
    const write = t.candidateToolSlugs.filter((s) => mockComposioV118ToolNeedsApproval(s)).length;
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
    totalToolkits: COMPOSIO_V118_MOCK_TOOLKITS.length,
    totalSlugs: mockComposioV118Slugs().length,
    writeSlugs,
    readSlugs: mockComposioV118Slugs().length - writeSlugs,
    byToolkit,
  };
}

// ---------------------------------------------------------------------------
// Mock executor — du lieu mau xac dinh cho tung slug
// ---------------------------------------------------------------------------

export interface MockComposioV118Result {
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
  // Canva
  CANVA_LIST_DESIGNS: { designs: [{ id: 'mock-design-1', title: 'Mock Design' }], total: 1 },
  CANVA_GET_DESIGN: { id: 'mock-design-1', title: 'Mock Design' },
  CANVA_CREATE_DESIGN: { id: 'mock-design-2', created: true },
  CANVA_UPDATE_DESIGN: { id: 'mock-design-1', updated: true },
  CANVA_DELETE_DESIGN: { id: 'mock-design-1', deleted: true },
  CANVA_LIST_BRAND_TEMPLATES: { templates: [{ id: 'mock-bt-1', title: 'Mock Brand Template' }], total: 1 },
  CANVA_GET_BRAND_TEMPLATE: { id: 'mock-bt-1', title: 'Mock Brand Template' },
  CANVA_CREATE_BRAND_TEMPLATE: { id: 'mock-bt-2', created: true },
  CANVA_LIST_FOLDERS: { folders: [{ id: 'mock-folder-1', name: 'Mock Folder' }], total: 1 },
  CANVA_EXPORT_DESIGN: { id: 'mock-design-1', exported: true, format: 'png' },
  // PandaDoc
  PANDADOC_LIST_DOCUMENTS: { documents: [{ id: 'mock-doc-1', status: 'sent' }], total: 1 },
  PANDADOC_GET_DOCUMENT: { id: 'mock-doc-1', status: 'sent' },
  PANDADOC_CREATE_DOCUMENT: { id: 'mock-doc-2', created: true },
  PANDADOC_SEND_DOCUMENT: { id: 'mock-doc-1', sent: true },
  PANDADOC_LIST_RECIPIENTS: { recipients: [{ id: 'mock-rec-1', name: 'Mock Recipient', status: 'sent' }], total: 1 },
  PANDADOC_GET_RECIPIENT_STATUS: { id: 'mock-rec-1', status: 'sent' },
  PANDADOC_LIST_TEMPLATES: { templates: [{ id: 'mock-tpl-1', name: 'Mock Template' }], total: 1 },
  PANDADOC_GET_TEMPLATE: { id: 'mock-tpl-1', name: 'Mock Template' },
  PANDADOC_DOWNLOAD_DOCUMENT: { id: 'mock-doc-1', downloaded: true },
  PANDADOC_VOID_DOCUMENT: { id: 'mock-doc-1', voided: true },
  // Loom
  LOOM_LIST_VIDEOS: { videos: [{ id: 'mock-video-1', title: 'Mock Video' }], total: 1 },
  LOOM_GET_VIDEO: { id: 'mock-video-1', title: 'Mock Video' },
  LOOM_CREATE_VIDEO: { id: 'mock-video-2', created: true },
  LOOM_UPDATE_VIDEO: { id: 'mock-video-1', updated: true },
  LOOM_DELETE_VIDEO: { id: 'mock-video-1', deleted: true },
  LOOM_LIST_COMMENTS: { comments: [{ id: 'mock-comment-1', text: 'Mock comment' }], total: 1 },
  LOOM_CREATE_COMMENT: { id: 'mock-comment-2', created: true },
  LOOM_LIST_FOLDERS: { folders: [{ id: 'mock-loom-folder-1', name: 'Mock Folder' }], total: 1 },
  LOOM_SHARE_VIDEO: { id: 'mock-video-1', shared: true },
  LOOM_GET_VIDEO_ANALYTICS: { id: 'mock-video-1', views: 42, plays: 40 },
};

/** Id xac dinh (deterministic) tu mot seed — de mock tra cung id moi lan. */
export function mockComposioV118DeterministicId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `mock-v118-${hash.toString(36)}`;
}

/** Tim toolkit chua slug tool ung vien; throw neu slug khong thuoc toolkit nao. */
export function resolveMockComposioV118Slug(toolkit: string, slug: string): ComposioV118MockToolkitDef {
  const def = findMockComposioV118Toolkit(toolkit);
  if (!def) throw new Error(`Unknown mock Composio v118 toolkit: ${toolkit}`);
  if (!def.candidateToolSlugs.includes(slug)) {
    throw new Error(`Unknown mock Composio v118 tool slug for ${toolkit}: ${slug}`);
  }
  return def;
}

/** Chay mot tool mock v118: tra du lieu mau + echo args, khong goi mang. */
export function executeMockComposioV118Tool(
  toolkit: string,
  slug: string,
  args: Record<string, unknown> = {},
): MockComposioV118Result {
  resolveMockComposioV118Slug(toolkit, slug);
  const sample = MOCK_SAMPLES[slug] ?? {};
  return {
    mock: true,
    live: false,
    toolkit,
    slug,
    data: { ...sample, echo: { ...args }, requestId: mockComposioV118DeterministicId(`${toolkit}:${slug}`) },
    note: MOCK_LIVE_NOTE,
  };
}

/** Executor dang class — de host/MCP bridge giu mot instance dung chung. */
export class MockComposioV118Executor {
  execute(toolkit: string, slug: string, args: Record<string, unknown> = {}): MockComposioV118Result {
    return executeMockComposioV118Tool(toolkit, slug, args);
  }

  listToolkits(): readonly ComposioV118MockToolkitDef[] {
    return COMPOSIO_V118_MOCK_TOOLKITS;
  }

  listSlugs(toolkit: string): string[] {
    const def = findMockComposioV118Toolkit(toolkit);
    if (!def) throw new Error(`Unknown mock Composio v118 toolkit: ${toolkit}`);
    return [...def.candidateToolSlugs];
  }
}
