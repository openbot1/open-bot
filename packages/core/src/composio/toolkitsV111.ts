/**
 * Composio toolkit MOCK v1.11 — 6 toolkit mới: Sentry, Datadog,
 * PostHog, Snowflake, Amplitude, Mixpanel (v1.11, Đội T6).
 *
 * ⚠️ MOCK-ONLY — ĐỌC KỸ TRƯỚC KHI BẬT LIVE (cùng tư thế v110):
 *
 * - Vault hiện KHÔNG có Composio API key, nên KHÔNG có cách nào
 *   gọi Composio thật trong sóng này. Mọi thứ trong file này chạy
 *   hoàn toàn local, không gọi mạng, không cần key.
 * - Slug tool liệt kê ở đây là SLUG ỨNG VIÊN (candidate), đặt theo
 *   quy ước đặt tên của Composio (PREFIX_VERB_NOUN), KHÔNG PHẢI
 *   slug đã xác nhận live. 6 toolkit này KHÔNG nằm trong
 *   COMPOSIO_TOOLKITS (40 toolkit đã xác nhận live vẫn nguyên vẹn),
 *   mà sống riêng ở đây dưới cờ `mockOnly: true, liveVerified: false`.
 * - Để bật live sau này (khi Huy đã nhập key thật vào Vault):
 *   1. Gọi `GET /api/v3.1/tools?toolkit_slug=<slug>` với key thật,
 *      đối chiếu từng slug ứng viên với slug thật Composio trả về.
 *   2. Slug nào khớp thì chuyển toolkit đó sang COMPOSIO_TOOLKITS
 *      (theo đúng 10 slug/cap M7), cập nhật pin đếm trong
 *      tests/composio-toolkits-a.test.mjs (40 → 46 toolkit,
 *      400 → 460 slug) — coordinator gộp tính lại.
 *   3. Slug nào không khớp thì sửa/xoá, KHÔNG được giữ slug bịa
 *      trong catalog live (bài học SLACK_POST_MESSAGE v0.57).
 * - Mock executor (`MockComposioV111Executor`) trả dữ liệu mẫu xác
 *   định (deterministic, không random, không thời gian thực) cho
 *   từng slug, đủ để UI + agent loop + test chạy end-to-end mà
 *   không cần key. Mọi response đều mang `mock: true, live: false`
 *   + ghi chú cần key thật để chạy live.
 * - Chọn 6 toolkit này vì chúng KHÔNG trùng 40 toolkit live
 *   (gmail/github/slack/notion/jira/linear/asana/hubspot/...) và
 *   KHÔNG trùng 6 toolkit mock v110 (figma/supabase/vercel/
 *   todoist/intercom/miro): observability + analytics + warehouse
 *   là nhóm app integration còn thiếu của fleet (giám sát lỗi,
 *   metric, product analytics, dữ liệu).
 */

import type { AppDefinition } from '../apps/types';
import { composioAppId, composioToolNeedsApproval } from './toolkits';

/** Khai báo một toolkit MOCK (chưa xác nhận live). */
export interface ComposioV111MockToolkitDef {
  /** Slug toolkit Composio ứng viên, vd 'sentry'. */
  slug: string;
  /** Tên hiển thị. */
  label: string;
  /** Biểu tượng hiển thị. */
  icon: string;
  /** Mô tả ngắn cho UI — luôn nói rõ đây là mock, chưa live. */
  description: string;
  /** Slug tool ỨNG VIÊN (chưa xác nhận live — xem ghi chú đầu file). */
  candidateToolSlugs: string[];
  /** Luôn true trong module này: toolkit chỉ chạy bằng mock. */
  mockOnly: true;
  /** Luôn false cho tới khi có người đối chiếu slug với API thật. */
  liveVerified: false;
}

/**
 * 6 toolkit mock — 10 slug ứng viên mỗi toolkit (bằng cap M7
 * `DEFAULT_APP_TOOL_CAP = 10`). Slug ứng viên, CHƯA xác nhận live.
 */
export const COMPOSIO_V111_MOCK_TOOLKITS: readonly ComposioV111MockToolkitDef[] = [
  {
    slug: 'sentry',
    label: 'Sentry (mock — via Composio)',
    icon: '🚨',
    description:
      '[MOCK] Đọc issue/error/event Sentry qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'SENTRY_LIST_ISSUES',
      'SENTRY_GET_ISSUE',
      'SENTRY_LIST_EVENTS',
      'SENTRY_GET_EVENT',
      'SENTRY_LIST_PROJECTS',
      'SENTRY_GET_PROJECT',
      'SENTRY_CREATE_ISSUE',
      'SENTRY_RESOLVE_ISSUE',
      'SENTRY_ASSIGN_ISSUE',
      'SENTRY_LIST_ORGANIZATIONS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'datadog',
    label: 'Datadog (mock — via Composio)',
    icon: '📊',
    description:
      '[MOCK] Đọc monitor/metric/log Datadog qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'DATADOG_LIST_MONITORS',
      'DATADOG_GET_MONITOR',
      'DATADOG_CREATE_MONITOR',
      'DATADOG_QUERY_METRICS',
      'DATADOG_LIST_DASHBOARDS',
      'DATADOG_GET_DASHBOARD',
      'DATADOG_LIST_INCIDENTS',
      'DATADOG_CREATE_INCIDENT',
      'DATADOG_SEARCH_LOGS',
      'DATADOG_LIST_SYNTHETICS_TESTS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'posthog',
    label: 'PostHog (mock — via Composio)',
    icon: '🦔',
    description:
      '[MOCK] Đọc event/insight PostHog qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'POSTHOG_LIST_EVENTS',
      'POSTHOG_CAPTURE_EVENT',
      'POSTHOG_LIST_INSIGHTS',
      'POSTHOG_GET_INSIGHT',
      'POSTHOG_LIST_PERSONS',
      'POSTHOG_GET_PERSON',
      'POSTHOG_LIST_FEATURE_FLAGS',
      'POSTHOG_GET_FEATURE_FLAG',
      'POSTHOG_LIST_SURVEYS',
      'POSTHOG_LIST_DASHBOARDS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'snowflake',
    label: 'Snowflake (mock — via Composio)',
    icon: '❄️',
    description:
      '[MOCK] Chạy query Snowflake qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'SNOWFLAKE_RUN_QUERY',
      'SNOWFLAKE_LIST_WAREHOUSES',
      'SNOWFLAKE_GET_WAREHOUSE',
      'SNOWFLAKE_LIST_DATABASES',
      'SNOWFLAKE_LIST_SCHEMAS',
      'SNOWFLAKE_LIST_TABLES',
      'SNOWFLAKE_DESCRIBE_TABLE',
      'SNOWFLAKE_LIST_USERS',
      'SNOWFLAKE_GET_QUERY_STATUS',
      'SNOWFLAKE_CANCEL_QUERY',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'amplitude',
    label: 'Amplitude (mock — via Composio)',
    icon: '📈',
    description:
      '[MOCK] Đọc event/chart Amplitude qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'AMPLITUDE_LIST_EVENTS',
      'AMPLITUDE_GET_EVENT_SEGMENTATION',
      'AMPLITUDE_LIST_CHARTS',
      'AMPLITUDE_GET_CHART',
      'AMPLITUDE_LIST_COHORTS',
      'AMPLITUDE_GET_COHORT',
      'AMPLITUDE_LIST_USERS',
      'AMPLITUDE_GET_USER',
      'AMPLITUDE_EXPORT_EVENTS',
      'AMPLITUDE_LIST_PROJECTS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'mixpanel',
    label: 'Mixpanel (mock — via Composio)',
    icon: '📉',
    description:
      '[MOCK] Đọc event/funnel Mixpanel qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'MIXPANEL_LIST_EVENTS',
      'MIXPANEL_QUERY_EVENTS',
      'MIXPANEL_LIST_FUNNELS',
      'MIXPANEL_GET_FUNNEL',
      'MIXPANEL_LIST_INSIGHTS',
      'MIXPANEL_GET_INSIGHT',
      'MIXPANEL_LIST_COHORTS',
      'MIXPANEL_GET_COHORT',
      'MIXPANEL_LIST_USERS',
      'MIXPANEL_EXPORT_EVENTS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
];

/** Tất cả slug ứng viên của 6 toolkit mock v111 (60 slug). */
export function mockComposioV111Slugs(): string[] {
  return COMPOSIO_V111_MOCK_TOOLKITS.flatMap((t) => [...t.candidateToolSlugs]);
}

/** Một toolkit mock v111 theo slug, hoặc undefined khi không có. */
export function findMockComposioV111Toolkit(slug: string): ComposioV111MockToolkitDef | undefined {
  return COMPOSIO_V111_MOCK_TOOLKITS.find((t) => t.slug === slug);
}

/** true khi slug là slug tool ứng viên của một toolkit mock v111. */
export function isMockComposioV111Slug(slug: string): boolean {
  return COMPOSIO_V111_MOCK_TOOLKITS.some((t) => t.candidateToolSlugs.includes(slug));
}

/** Tool mock có cần approval không — cùng luật động từ ghi như tool Composio thật. */
export function mockComposioV111ToolNeedsApproval(slug: string): boolean {
  return composioToolNeedsApproval(slug);
}

/** App id của một toolkit mock: 'composio-<toolkit>' (cùng quy ước với toolkit thật). */
export function mockComposioV111AppId(toolkit: string): string {
  return composioAppId(toolkit);
}

/**
 * AppDefinition cho 6 toolkit mock — để UI bật/tắt + liệt kê tool
 * như toolkit thật, nhưng mô tả luôn gắn cờ [MOCK] để người dùng
 * không nhầm với kết nối live.
 */
export function createMockComposioV111AppDefinitions(): AppDefinition[] {
  return COMPOSIO_V111_MOCK_TOOLKITS.map((toolkit) => ({
    id: mockComposioV111AppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.candidateToolSlugs.map((slug) => ({
      name: slug,
      description: `[MOCK] Tool Composio ${slug} — slug ứng viên chưa xác nhận live, chỉ chạy bằng dữ liệu mẫu local.`,
      needsApproval: mockComposioV111ToolNeedsApproval(slug),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Mock executor — dữ liệu mẫu xác định cho từng slug
// ---------------------------------------------------------------------------

export interface MockComposioV111Result {
  mock: true;
  live: false;
  toolkit: string;
  slug: string;
  /** Dữ liệu mẫu (đã gộp field echo từ args khi tên field trùng). */
  data: Record<string, unknown>;
  /** Ghi chú bật live: cần key thật + xác nhận slug. */
  note: string;
}

const MOCK_LIVE_NOTE =
  'Mock response — no live Composio call was made. To run for real, add a Composio API key to the Vault and verify this slug against the live Composio catalog first.';

/**
 * Dữ liệu mẫu cho từng slug ứng viên. Mỗi mẫu là một object phẳng
 * (field nào cũng là string/number/boolean/array phẳng) để test và
 * UI đọc được mà không cần schema live. `args` của caller được echo
 * vào `data.echo` nguyên vẹn — mock không bao giờ "thực thi" gì.
 */
const MOCK_SAMPLES: Record<string, Record<string, unknown>> = {
  // Sentry
  SENTRY_LIST_ISSUES: { issues: [{ id: 'mock-issue-1', title: 'Mock error', level: 'error' }], total: 1 },
  SENTRY_GET_ISSUE: { id: 'mock-issue-1', title: 'Mock error', level: 'error', status: 'unresolved' },
  SENTRY_LIST_EVENTS: { events: [{ id: 'mock-event-1', type: 'error' }], total: 1 },
  SENTRY_GET_EVENT: { id: 'mock-event-1', type: 'error', message: 'Mock event' },
  SENTRY_LIST_PROJECTS: { projects: [{ id: 'mock-project-1', name: 'mock-open-bot' }], total: 1 },
  SENTRY_GET_PROJECT: { id: 'mock-project-1', name: 'mock-open-bot', platform: 'node' },
  SENTRY_CREATE_ISSUE: { id: 'mock-issue-2', created: true },
  SENTRY_RESOLVE_ISSUE: { id: 'mock-issue-1', status: 'resolved' },
  SENTRY_ASSIGN_ISSUE: { id: 'mock-issue-1', assignedTo: 'mock-user' },
  SENTRY_LIST_ORGANIZATIONS: { organizations: [{ id: 'mock-org-1', name: 'Mock Org' }], total: 1 },
  // Datadog
  DATADOG_LIST_MONITORS: { monitors: [{ id: 'mock-monitor-1', name: 'Mock monitor', status: 'OK' }], total: 1 },
  DATADOG_GET_MONITOR: { id: 'mock-monitor-1', name: 'Mock monitor', status: 'OK' },
  DATADOG_CREATE_MONITOR: { id: 'mock-monitor-2', created: true },
  DATADOG_QUERY_METRICS: { series: [{ metric: 'mock.metric', points: [[0, 1]] }], total: 1 },
  DATADOG_LIST_DASHBOARDS: { dashboards: [{ id: 'mock-dash-1', title: 'Mock Dashboard' }], total: 1 },
  DATADOG_GET_DASHBOARD: { id: 'mock-dash-1', title: 'Mock Dashboard' },
  DATADOG_LIST_INCIDENTS: { incidents: [{ id: 'mock-incident-1', state: 'active' }], total: 1 },
  DATADOG_CREATE_INCIDENT: { id: 'mock-incident-2', created: true },
  DATADOG_SEARCH_LOGS: { logs: [{ id: 'mock-log-1', message: 'Mock log' }], total: 1 },
  DATADOG_LIST_SYNTHETICS_TESTS: { tests: [{ id: 'mock-test-1', name: 'Mock test' }], total: 1 },
  // PostHog
  POSTHOG_LIST_EVENTS: { events: [{ id: 'mock-ev-1', event: 'mock_event' }], total: 1 },
  POSTHOG_CAPTURE_EVENT: { event: 'mock_event', captured: true },
  POSTHOG_LIST_INSIGHTS: { insights: [{ id: 'mock-insight-1', name: 'Mock insight' }], total: 1 },
  POSTHOG_GET_INSIGHT: { id: 'mock-insight-1', name: 'Mock insight' },
  POSTHOG_LIST_PERSONS: { persons: [{ id: 'mock-person-1', email: 'mock@example.com' }], total: 1 },
  POSTHOG_GET_PERSON: { id: 'mock-person-1', email: 'mock@example.com' },
  POSTHOG_LIST_FEATURE_FLAGS: { flags: [{ key: 'mock-flag', active: true }], total: 1 },
  POSTHOG_GET_FEATURE_FLAG: { key: 'mock-flag', active: true },
  POSTHOG_LIST_SURVEYS: { surveys: [{ id: 'mock-survey-1', name: 'Mock survey' }], total: 1 },
  POSTHOG_LIST_DASHBOARDS: { dashboards: [{ id: 'mock-dash-1', name: 'Mock Dashboard' }], total: 1 },
  // Snowflake
  SNOWFLAKE_RUN_QUERY: { queryId: 'mock-query-1', rows: [{ MOCK_COL: 'mock-value' }], total: 1 },
  SNOWFLAKE_LIST_WAREHOUSES: { warehouses: [{ name: 'MOCK_WH', state: 'SUSPENDED' }], total: 1 },
  SNOWFLAKE_GET_WAREHOUSE: { name: 'MOCK_WH', state: 'SUSPENDED' },
  SNOWFLAKE_LIST_DATABASES: { databases: ['MOCK_DB'], total: 1 },
  SNOWFLAKE_LIST_SCHEMAS: { schemas: ['MOCK_SCHEMA'], total: 1 },
  SNOWFLAKE_LIST_TABLES: { tables: ['MOCK_TABLE'], total: 1 },
  SNOWFLAKE_DESCRIBE_TABLE: { table: 'MOCK_TABLE', columns: ['id', 'name'] },
  SNOWFLAKE_LIST_USERS: { users: [{ name: 'MOCK_USER' }], total: 1 },
  SNOWFLAKE_GET_QUERY_STATUS: { queryId: 'mock-query-1', status: 'SUCCESS' },
  SNOWFLAKE_CANCEL_QUERY: { queryId: 'mock-query-1', cancelled: true },
  // Amplitude
  AMPLITUDE_LIST_EVENTS: { events: [{ name: 'mock_event', count: 1 }], total: 1 },
  AMPLITUDE_GET_EVENT_SEGMENTATION: { event: 'mock_event', segments: [{ name: 'mock', count: 1 }] },
  AMPLITUDE_LIST_CHARTS: { charts: [{ id: 'mock-chart-1', name: 'Mock chart' }], total: 1 },
  AMPLITUDE_GET_CHART: { id: 'mock-chart-1', name: 'Mock chart' },
  AMPLITUDE_LIST_COHORTS: { cohorts: [{ id: 'mock-cohort-1', name: 'Mock cohort' }], total: 1 },
  AMPLITUDE_GET_COHORT: { id: 'mock-cohort-1', name: 'Mock cohort' },
  AMPLITUDE_LIST_USERS: { users: [{ id: 'mock-user-1' }], total: 1 },
  AMPLITUDE_GET_USER: { id: 'mock-user-1' },
  AMPLITUDE_EXPORT_EVENTS: { exportId: 'mock-export-1', status: 'queued' },
  AMPLITUDE_LIST_PROJECTS: { projects: [{ id: 'mock-project-1', name: 'Mock Project' }], total: 1 },
  // Mixpanel
  MIXPANEL_LIST_EVENTS: { events: [{ name: 'mock_event', count: 1 }], total: 1 },
  MIXPANEL_QUERY_EVENTS: { events: [{ name: 'mock_event', count: 1 }], total: 1 },
  MIXPANEL_LIST_FUNNELS: { funnels: [{ id: 'mock-funnel-1', name: 'Mock funnel' }], total: 1 },
  MIXPANEL_GET_FUNNEL: { id: 'mock-funnel-1', name: 'Mock funnel' },
  MIXPANEL_LIST_INSIGHTS: { insights: [{ id: 'mock-insight-1', name: 'Mock insight' }], total: 1 },
  MIXPANEL_GET_INSIGHT: { id: 'mock-insight-1', name: 'Mock insight' },
  MIXPANEL_LIST_COHORTS: { cohorts: [{ id: 'mock-cohort-1', name: 'Mock cohort' }], total: 1 },
  MIXPANEL_GET_COHORT: { id: 'mock-cohort-1', name: 'Mock cohort' },
  MIXPANEL_LIST_USERS: { users: [{ id: 'mock-user-1' }], total: 1 },
  MIXPANEL_EXPORT_EVENTS: { exportId: 'mock-export-1', status: 'queued' },
};

/** Id xác định (deterministic) từ một seed — để mock trả cùng id mỗi lần. */
export function mockComposioV111DeterministicId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `mock-v111-${hash.toString(36)}`;
}

/**
 * Executor mock: chạy một slug ứng viên bằng dữ liệu mẫu local.
 * Throw `Error` khi slug không phải slug mock v111 (fail-closed:
 * không bao giờ "đoán" dữ liệu cho slug lạ). Không gọi mạng.
 */
export class MockComposioV111Executor {
  execute(toolkit: string, slug: string, args: Record<string, unknown> = {}): MockComposioV111Result {
    const def = findMockComposioV111Toolkit(toolkit);
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

/** Hàm tiện ích: chạy một slug mock v111 (tạo executor mới mỗi lần). */
export function executeMockComposioV111Tool(
  toolkit: string,
  slug: string,
  args: Record<string, unknown> = {},
): MockComposioV111Result {
  return new MockComposioV111Executor().execute(toolkit, slug, args);
}
