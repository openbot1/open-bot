/**
 * Composio toolkit MOCK v1.12 — 6 toolkit moi: Grafana, Elasticsearch,
 * BigQuery, ClickHouse, LaunchDarkly, Greenhouse (v1.12, Doi T6).
 *
 * MOCK-ONLY — CUNG TU THE v110/v111:
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
 * - Mock executor (`MockComposioV112Executor`) tra du lieu mau xac
 *   dinh (deterministic, khong random, khong thoi gian thuc) cho
 *   tung slug, du de UI + agent loop + test chay end-to-end ma
 *   khong can key. Moi response deu mang `mock: true, live: false`
 *   + ghi chu can key that de chay live.
 * - Chon 6 toolkit nay vi chung KHONG trung 40 toolkit live
 *   (gmail/github/slack/notion/jira/linear/asana/hubspot/...) va
 *   KHONG trung 6 toolkit mock v110 (figma/supabase/vercel/
 *   todoist/intercom/miro) cung 6 toolkit mock v111 (sentry/
 *   datadog/posthog/snowflake/amplitude/mixpanel): observability +
 *   warehouse + feature flag + tuyen dung la nhom app integration
 *   con thieu cua fleet (dashboard metric, tim kiem log, query
 *   du lieu lon, co tinh nang, pipeline tuyen dung).
 */

import type { AppDefinition } from '../apps/types';
import { composioAppId, composioToolNeedsApproval } from './toolkits';

/** Khai bao mot toolkit MOCK (chua xac nhan live). */
export interface ComposioV112MockToolkitDef {
  /** Slug toolkit Composio ung vien, vd 'grafana'. */
  slug: string;
  /** Ten hien thi. */
  label: string;
  /** Bieu tuong hien thi. */
  icon: string;
  /** Mo ta ngan cho UI — luon noi ro day la mock, chua live. */
  description: string;
  /** Slug tool UNG VIEN (chua xac nhan live — xem ghi chu dau file). */
  candidateToolSlugs: string[];
  /** Luon true trong module nay: toolkit chi chay bang mock. */
  mockOnly: true;
  /** Luon false cho toi khi co nguoi doi chieu slug voi API that. */
  liveVerified: false;
}

/**
 * 6 toolkit mock — 10 slug ung vien moi toolkit (bang cap M7
 * `DEFAULT_APP_TOOL_CAP = 10`). Slug ung vien, CHUA xac nhan live.
 */
export const COMPOSIO_V112_MOCK_TOOLKITS: readonly ComposioV112MockToolkitDef[] = [
  {
    slug: 'grafana',
    label: 'Grafana (mock — via Composio)',
    icon: '📈',
    description:
      '[MOCK] Doc dashboard/panel/alert Grafana qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'GRAFANA_LIST_DASHBOARDS',
      'GRAFANA_GET_DASHBOARD',
      'GRAFANA_CREATE_DASHBOARD',
      'GRAFANA_LIST_PANELS',
      'GRAFANA_QUERY_DATA_SOURCE',
      'GRAFANA_LIST_DATA_SOURCES',
      'GRAFANA_LIST_ALERT_RULES',
      'GRAFANA_GET_ALERT_RULE',
      'GRAFANA_CREATE_ALERT_RULE',
      'GRAFANA_LIST_FOLDERS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'elasticsearch',
    label: 'Elasticsearch (mock — via Composio)',
    icon: '🔍',
    description:
      '[MOCK] Tim kiem document/index Elasticsearch qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'ELASTICSEARCH_SEARCH_DOCUMENTS',
      'ELASTICSEARCH_GET_DOCUMENT',
      'ELASTICSEARCH_INDEX_DOCUMENT',
      'ELASTICSEARCH_DELETE_DOCUMENT',
      'ELASTICSEARCH_LIST_INDICES',
      'ELASTICSEARCH_GET_INDEX',
      'ELASTICSEARCH_CREATE_INDEX',
      'ELASTICSEARCH_DELETE_INDEX',
      'ELASTICSEARCH_CLUSTER_HEALTH',
      'ELASTICSEARCH_COUNT_DOCUMENTS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'bigquery',
    label: 'BigQuery (mock — via Composio)',
    icon: '🗄️',
    description:
      '[MOCK] Chay query BigQuery qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'BIGQUERY_RUN_QUERY',
      'BIGQUERY_LIST_DATASETS',
      'BIGQUERY_GET_DATASET',
      'BIGQUERY_LIST_TABLES',
      'BIGQUERY_GET_TABLE',
      'BIGQUERY_LIST_JOBS',
      'BIGQUERY_GET_JOB',
      'BIGQUERY_CANCEL_JOB',
      'BIGQUERY_INSERT_ROWS',
      'BIGQUERY_DESCRIBE_TABLE',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'clickhouse',
    label: 'ClickHouse (mock — via Composio)',
    icon: '⚡',
    description:
      '[MOCK] Chay query ClickHouse qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'CLICKHOUSE_RUN_QUERY',
      'CLICKHOUSE_LIST_DATABASES',
      'CLICKHOUSE_LIST_TABLES',
      'CLICKHOUSE_GET_TABLE',
      'CLICKHOUSE_DESCRIBE_TABLE',
      'CLICKHOUSE_INSERT_ROWS',
      'CLICKHOUSE_LIST_COLUMNS',
      'CLICKHOUSE_GET_QUERY_STATUS',
      'CLICKHOUSE_CANCEL_QUERY',
      'CLICKHOUSE_TABLE_SIZE',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'launchdarkly',
    label: 'LaunchDarkly (mock — via Composio)',
    icon: '🚩',
    description:
      '[MOCK] Doc feature flag LaunchDarkly qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'LAUNCHDARKLY_LIST_FLAGS',
      'LAUNCHDARKLY_GET_FLAG',
      'LAUNCHDARKLY_CREATE_FLAG',
      'LAUNCHDARKLY_UPDATE_FLAG',
      'LAUNCHDARKLY_TOGGLE_FLAG',
      'LAUNCHDARKLY_LIST_ENVIRONMENTS',
      'LAUNCHDARKLY_LIST_PROJECTS',
      'LAUNCHDARKLY_GET_FLAG_STATUS',
      'LAUNCHDARKLY_LIST_SEGMENTS',
      'LAUNCHDARKLY_EVALUATE_FLAG',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'greenhouse',
    label: 'Greenhouse (mock — via Composio)',
    icon: '🌱',
    description:
      '[MOCK] Doc ung vien/viec lam Greenhouse qua Composio. Chua goi API that: Vault chua co Composio API key, slug ung vien chua doi chieu live. Bat live can key that + xac nhan slug (xem ghi chu dau file).',
    candidateToolSlugs: [
      'GREENHOUSE_LIST_JOBS',
      'GREENHOUSE_GET_JOB',
      'GREENHOUSE_LIST_CANDIDATES',
      'GREENHOUSE_GET_CANDIDATE',
      'GREENHOUSE_LIST_APPLICATIONS',
      'GREENHOUSE_GET_APPLICATION',
      'GREENHOUSE_CREATE_CANDIDATE',
      'GREENHOUSE_MOVE_CANDIDATE',
      'GREENHOUSE_LIST_INTERVIEWS',
      'GREENHOUSE_LIST_OFFERS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
];

/** Tat ca slug ung vien cua 6 toolkit mock v112 (60 slug). */
export function mockComposioV112Slugs(): string[] {
  return COMPOSIO_V112_MOCK_TOOLKITS.flatMap((t) => [...t.candidateToolSlugs]);
}

/** Mot toolkit mock v112 theo slug, hoac undefined khi khong co. */
export function findMockComposioV112Toolkit(slug: string): ComposioV112MockToolkitDef | undefined {
  return COMPOSIO_V112_MOCK_TOOLKITS.find((t) => t.slug === slug);
}

/** true khi slug la slug tool ung vien cua mot toolkit mock v112. */
export function isMockComposioV112Slug(slug: string): boolean {
  return COMPOSIO_V112_MOCK_TOOLKITS.some((t) => t.candidateToolSlugs.includes(slug));
}

/** Tool mock co can approval khong — cung luat dong tu ghi nhu tool Composio that. */
export function mockComposioV112ToolNeedsApproval(slug: string): boolean {
  return composioToolNeedsApproval(slug);
}

/** App id cua mot toolkit mock: 'composio-<toolkit>' (cung quy uoc voi toolkit that). */
export function mockComposioV112AppId(toolkit: string): string {
  return composioAppId(toolkit);
}

/**
 * AppDefinition cho 6 toolkit mock — de UI bat/tat + liet ke tool
 * nhu toolkit that, nhung mo ta luon gan co [MOCK] de nguoi dung
 * khong nham voi ket noi live.
 */
export function createMockComposioV112AppDefinitions(): AppDefinition[] {
  return COMPOSIO_V112_MOCK_TOOLKITS.map((toolkit) => ({
    id: mockComposioV112AppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.candidateToolSlugs.map((slug) => ({
      name: slug,
      description: `[MOCK] Tool Composio ${slug} — slug ung vien chua xac nhan live, chi chay bang du lieu mau local.`,
      needsApproval: mockComposioV112ToolNeedsApproval(slug),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Mock executor — du lieu mau xac dinh cho tung slug
// ---------------------------------------------------------------------------

export interface MockComposioV112Result {
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
  // Grafana
  GRAFANA_LIST_DASHBOARDS: { dashboards: [{ id: 'mock-dash-1', title: 'Mock Dashboard' }], total: 1 },
  GRAFANA_GET_DASHBOARD: { id: 'mock-dash-1', title: 'Mock Dashboard' },
  GRAFANA_CREATE_DASHBOARD: { id: 'mock-dash-2', created: true },
  GRAFANA_LIST_PANELS: { panels: [{ id: 'mock-panel-1', title: 'Mock Panel' }], total: 1 },
  GRAFANA_QUERY_DATA_SOURCE: { results: [{ metric: 'mock.metric', points: [[0, 1]] }], total: 1 },
  GRAFANA_LIST_DATA_SOURCES: { dataSources: [{ id: 'mock-ds-1', name: 'Mock DS', type: 'prometheus' }], total: 1 },
  GRAFANA_LIST_ALERT_RULES: { alertRules: [{ id: 'mock-alert-1', name: 'Mock alert', state: 'Normal' }], total: 1 },
  GRAFANA_GET_ALERT_RULE: { id: 'mock-alert-1', name: 'Mock alert', state: 'Normal' },
  GRAFANA_CREATE_ALERT_RULE: { id: 'mock-alert-2', created: true },
  GRAFANA_LIST_FOLDERS: { folders: [{ id: 'mock-folder-1', title: 'Mock Folder' }], total: 1 },
  // Elasticsearch
  ELASTICSEARCH_SEARCH_DOCUMENTS: { documents: [{ id: 'mock-doc-1', score: 1 }], total: 1 },
  ELASTICSEARCH_GET_DOCUMENT: { id: 'mock-doc-1', source: { message: 'Mock document' } },
  ELASTICSEARCH_INDEX_DOCUMENT: { id: 'mock-doc-2', created: true },
  ELASTICSEARCH_DELETE_DOCUMENT: { id: 'mock-doc-1', deleted: true },
  ELASTICSEARCH_LIST_INDICES: { indices: [{ name: 'mock-index-1', docs: 1 }], total: 1 },
  ELASTICSEARCH_GET_INDEX: { name: 'mock-index-1', docs: 1 },
  ELASTICSEARCH_CREATE_INDEX: { name: 'mock-index-2', created: true },
  ELASTICSEARCH_DELETE_INDEX: { name: 'mock-index-1', deleted: true },
  ELASTICSEARCH_CLUSTER_HEALTH: { status: 'green', nodes: 1 },
  ELASTICSEARCH_COUNT_DOCUMENTS: { count: 1 },
  // BigQuery
  BIGQUERY_RUN_QUERY: { rows: [{ mock_col: 'mock-value' }], totalRows: 1 },
  BIGQUERY_LIST_DATASETS: { datasets: [{ id: 'mock-dataset-1' }], total: 1 },
  BIGQUERY_GET_DATASET: { id: 'mock-dataset-1', location: 'US' },
  BIGQUERY_LIST_TABLES: { tables: [{ id: 'mock-table-1' }], total: 1 },
  BIGQUERY_GET_TABLE: { id: 'mock-table-1', rows: 1 },
  BIGQUERY_LIST_JOBS: { jobs: [{ id: 'mock-job-1', state: 'DONE' }], total: 1 },
  BIGQUERY_GET_JOB: { id: 'mock-job-1', state: 'DONE' },
  BIGQUERY_CANCEL_JOB: { id: 'mock-job-1', cancelled: true },
  BIGQUERY_INSERT_ROWS: { inserted: 1 },
  BIGQUERY_DESCRIBE_TABLE: { id: 'mock-table-1', schema: [{ name: 'mock_col', type: 'STRING' }] },
  // ClickHouse
  CLICKHOUSE_RUN_QUERY: { rows: [{ mock_col: 'mock-value' }], totalRows: 1 },
  CLICKHOUSE_LIST_DATABASES: { databases: [{ name: 'mock-db-1' }], total: 1 },
  CLICKHOUSE_LIST_TABLES: { tables: [{ name: 'mock-table-1' }], total: 1 },
  CLICKHOUSE_GET_TABLE: { name: 'mock-table-1', rows: 1 },
  CLICKHOUSE_DESCRIBE_TABLE: { name: 'mock-table-1', columns: [{ name: 'mock_col', type: 'String' }] },
  CLICKHOUSE_INSERT_ROWS: { inserted: 1 },
  CLICKHOUSE_LIST_COLUMNS: { columns: [{ name: 'mock_col', type: 'String' }], total: 1 },
  CLICKHOUSE_GET_QUERY_STATUS: { queryId: 'mock-query-1', status: 'finished' },
  CLICKHOUSE_CANCEL_QUERY: { queryId: 'mock-query-1', cancelled: true },
  CLICKHOUSE_TABLE_SIZE: { name: 'mock-table-1', bytes: 1024 },
  // LaunchDarkly
  LAUNCHDARKLY_LIST_FLAGS: { flags: [{ key: 'mock-flag-1', name: 'Mock flag', on: true }], total: 1 },
  LAUNCHDARKLY_GET_FLAG: { key: 'mock-flag-1', name: 'Mock flag', on: true },
  LAUNCHDARKLY_CREATE_FLAG: { key: 'mock-flag-2', created: true },
  LAUNCHDARKLY_UPDATE_FLAG: { key: 'mock-flag-1', updated: true },
  LAUNCHDARKLY_TOGGLE_FLAG: { key: 'mock-flag-1', on: false },
  LAUNCHDARKLY_LIST_ENVIRONMENTS: { environments: [{ key: 'mock-env-1', name: 'Mock env' }], total: 1 },
  LAUNCHDARKLY_LIST_PROJECTS: { projects: [{ key: 'mock-proj-1', name: 'Mock project' }], total: 1 },
  LAUNCHDARKLY_GET_FLAG_STATUS: { key: 'mock-flag-1', status: 'active' },
  LAUNCHDARKLY_LIST_SEGMENTS: { segments: [{ key: 'mock-seg-1', name: 'Mock segment' }], total: 1 },
  LAUNCHDARKLY_EVALUATE_FLAG: { key: 'mock-flag-1', value: true },
  // Greenhouse
  GREENHOUSE_LIST_JOBS: { jobs: [{ id: 'mock-job-1', title: 'Mock Engineer' }], total: 1 },
  GREENHOUSE_GET_JOB: { id: 'mock-job-1', title: 'Mock Engineer' },
  GREENHOUSE_LIST_CANDIDATES: { candidates: [{ id: 'mock-cand-1', name: 'Mock Candidate' }], total: 1 },
  GREENHOUSE_GET_CANDIDATE: { id: 'mock-cand-1', name: 'Mock Candidate' },
  GREENHOUSE_LIST_APPLICATIONS: { applications: [{ id: 'mock-app-1', status: 'active' }], total: 1 },
  GREENHOUSE_GET_APPLICATION: { id: 'mock-app-1', status: 'active' },
  GREENHOUSE_CREATE_CANDIDATE: { id: 'mock-cand-2', created: true },
  GREENHOUSE_MOVE_CANDIDATE: { id: 'mock-cand-1', stage: 'interview' },
  GREENHOUSE_LIST_INTERVIEWS: { interviews: [{ id: 'mock-int-1', status: 'scheduled' }], total: 1 },
  GREENHOUSE_LIST_OFFERS: { offers: [{ id: 'mock-offer-1', status: 'draft' }], total: 1 },
};

/** Id xac dinh (deterministic) tu mot seed — de mock tra cung id moi lan. */
export function mockComposioV112DeterministicId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `mock-v112-${hash.toString(36)}`;
}

/**
 * Executor mock: chay mot slug ung vien bang du lieu mau local.
 * Throw `Error` khi slug khong phai slug mock v112 (fail-closed:
 * khong bao gio "doan" du lieu cho slug la). Khong goi mang.
 */
export class MockComposioV112Executor {
  execute(toolkit: string, slug: string, args: Record<string, unknown> = {}): MockComposioV112Result {
    const def = findMockComposioV112Toolkit(toolkit);
    if (!def) throw new Error(`Unknown mock toolkit: ${toolkit}`);
    if (!def.candidateToolSlugs.includes(slug)) {
      throw new Error(`Slug ${slug} is not a candidate tool of mock toolkit ${toolkit}.`);
    }
    const sample = MOCK_SAMPLES[slug];
    if (!sample) throw new Error(`No mock sample for slug ${slug}.`);
    return {
      mock: true,
      live: false,
      toolkit,
      slug,
      data: { ...sample, echo: args },
      note: MOCK_LIVE_NOTE,
    };
  }
}

/** Ham tien ich: chay mot slug mock v112 (tao executor moi moi lan). */
export function executeMockComposioV112Tool(
  toolkit: string,
  slug: string,
  args: Record<string, unknown> = {},
): MockComposioV112Result {
  return new MockComposioV112Executor().execute(toolkit, slug, args);
}

/**
 * Tom tat nhanh catalogue mock v112 (cho UI/tools): moi toolkit kem
 * so slug ung vien + co can approval cho tool ghi hay khong.
 */
export function summarizeMockComposioV112Catalogue(): {
  toolkit: string;
  label: string;
  toolCount: number;
  writeTools: string[];
}[] {
  return COMPOSIO_V112_MOCK_TOOLKITS.map((t) => ({
    toolkit: t.slug,
    label: t.label,
    toolCount: t.candidateToolSlugs.length,
    writeTools: t.candidateToolSlugs.filter((slug) => mockComposioV112ToolNeedsApproval(slug)),
  }));
}
