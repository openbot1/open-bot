/**
 * Composio toolkit MOCK v1.10 — 6 toolkit mới: Figma, Supabase,
 * Vercel, Todoist, Intercom, Miro (v1.10, Đội T6).
 *
 * ⚠️ MOCK-ONLY — ĐỌC KỸ TRƯỚC KHI BẬT LIVE:
 *
 * - Vault hiện KHÔNG có Composio API key, nên KHÔNG có cách nào
 *   gọi Composio thật trong sóng này. Mọi thứ trong file này chạy
 *   hoàn toàn local, không gọi mạng, không cần key.
 * - Slug tool liệt kê ở đây là SLUG ỨNG VIÊN (candidate), đặt theo
 *   quy ước đặt tên của Composio (PREFIX_VERB_NOUN), KHÔNG PHẢI
 *   slug đã xác nhận live. File toolkits.ts nghiêm cấm thêm slug
 *   chưa đối chiếu live — vì vậy 6 toolkit này KHÔNG nằm trong
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
 * - Mock executor (`MockComposioV110Executor`) trả dữ liệu mẫu xác
 *   định (deterministic, không random, không thời gian thực) cho
 *   từng slug, đủ để UI + agent loop + test chạy end-to-end mà
 *   không cần key. Mọi response đều mang `mock: true, live: false`
 *   + ghi chú cần key thật để chạy live.
 */

import type { AppDefinition } from '../apps/types';
import { composioAppId, composioToolNeedsApproval } from './toolkits';

/** Khai báo một toolkit MOCK (chưa xác nhận live). */
export interface ComposioV110MockToolkitDef {
  /** Slug toolkit Composio ứng viên, vd 'figma'. */
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
export const COMPOSIO_V110_MOCK_TOOLKITS: readonly ComposioV110MockToolkitDef[] = [
  {
    slug: 'figma',
    label: 'Figma (mock — via Composio)',
    icon: '🎨',
    description:
      '[MOCK] Đọc file/component/comment Figma qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'FIGMA_GET_FILE',
      'FIGMA_LIST_PROJECT_FILES',
      'FIGMA_GET_COMPONENTS',
      'FIGMA_GET_STYLES',
      'FIGMA_GET_FILE_COMMENTS',
      'FIGMA_CREATE_COMMENT',
      'FIGMA_GET_TEAM_PROJECTS',
      'FIGMA_GET_PROJECT_FILES',
      'FIGMA_GET_FILE_NODES',
      'FIGMA_DOWNLOAD_FILE_IMAGES',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'supabase',
    label: 'Supabase (mock — via Composio)',
    icon: '⚡',
    description:
      '[MOCK] Truy vấn bảng, auth user, storage Supabase qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'SUPABASE_QUERY_TABLE',
      'SUPABASE_LIST_TABLES',
      'SUPABASE_INSERT_ROW',
      'SUPABASE_UPDATE_ROW',
      'SUPABASE_DELETE_ROW',
      'SUPABASE_LIST_USERS',
      'SUPABASE_GET_USER',
      'SUPABASE_LIST_BUCKETS',
      'SUPABASE_UPLOAD_FILE',
      'SUPABASE_LIST_STORAGE_FILES',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'vercel',
    label: 'Vercel (mock — via Composio)',
    icon: '▲',
    description:
      '[MOCK] Xem deployment/project/domain Vercel qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'VERCEL_LIST_DEPLOYMENTS',
      'VERCEL_GET_DEPLOYMENT',
      'VERCEL_LIST_PROJECTS',
      'VERCEL_GET_PROJECT',
      'VERCEL_CREATE_DEPLOYMENT',
      'VERCEL_LIST_DOMAINS',
      'VERCEL_GET_DOMAIN',
      'VERCEL_LIST_ENV_VARS',
      'VERCEL_CREATE_ENV_VAR',
      'VERCEL_DELETE_DEPLOYMENT',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'todoist',
    label: 'Todoist (mock — via Composio)',
    icon: '✅',
    description:
      '[MOCK] Quản lý task/project Todoist qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'TODOIST_LIST_TASKS',
      'TODOIST_GET_TASK',
      'TODOIST_CREATE_TASK',
      'TODOIST_UPDATE_TASK',
      'TODOIST_COMPLETE_TASK',
      'TODOIST_DELETE_TASK',
      'TODOIST_LIST_PROJECTS',
      'TODOIST_CREATE_PROJECT',
      'TODOIST_LIST_LABELS',
      'TODOIST_SEARCH_TASKS',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'intercom',
    label: 'Intercom (mock — via Composio)',
    icon: '💬',
    description:
      '[MOCK] Quản lý conversation/contact Intercom qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'INTERCOM_LIST_CONVERSATIONS',
      'INTERCOM_GET_CONVERSATION',
      'INTERCOM_REPLY_CONVERSATION',
      'INTERCOM_CLOSE_CONVERSATION',
      'INTERCOM_LIST_CONTACTS',
      'INTERCOM_GET_CONTACT',
      'INTERCOM_CREATE_CONTACT',
      'INTERCOM_SEARCH_ARTICLES',
      'INTERCOM_LIST_ADMINS',
      'INTERCOM_CREATE_TICKET',
    ],
    mockOnly: true,
    liveVerified: false,
  },
  {
    slug: 'miro',
    label: 'Miro (mock — via Composio)',
    icon: '🧩',
    description:
      '[MOCK] Quản lý board/item Miro qua Composio. Chưa gọi API thật: Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).',
    candidateToolSlugs: [
      'MIRO_LIST_BOARDS',
      'MIRO_GET_BOARD',
      'MIRO_CREATE_BOARD',
      'MIRO_LIST_BOARD_ITEMS',
      'MIRO_CREATE_STICKY_NOTE',
      'MIRO_CREATE_SHAPE',
      'MIRO_GET_BOARD_MEMBERS',
      'MIRO_SHARE_BOARD',
      'MIRO_DELETE_BOARD',
      'MIRO_UPDATE_BOARD',
    ],
    mockOnly: true,
    liveVerified: false,
  },
];

/** Toàn bộ slug ứng viên của 6 toolkit mock (60 slug). */
export function mockComposioV110Slugs(): string[] {
  return COMPOSIO_V110_MOCK_TOOLKITS.flatMap((t) => [...t.candidateToolSlugs]);
}

/** Tìm toolkit mock theo slug (undefined khi không phải toolkit mock v110). */
export function findMockComposioV110Toolkit(slug: string): ComposioV110MockToolkitDef | undefined {
  return COMPOSIO_V110_MOCK_TOOLKITS.find((t) => t.slug === slug);
}

/** true khi slug thuộc một trong 6 toolkit mock v110. */
export function isMockComposioV110Slug(slug: string): boolean {
  return mockComposioV110Slugs().includes(slug);
}

/** Tool mock có cần approval không — cùng luật động từ ghi như tool Composio thật. */
export function mockComposioV110ToolNeedsApproval(slug: string): boolean {
  return composioToolNeedsApproval(slug);
}

/** App id của một toolkit mock: 'composio-<toolkit>' (cùng quy ước với toolkit thật). */
export function mockComposioV110AppId(toolkit: string): string {
  return composioAppId(toolkit);
}

/**
 * AppDefinition cho 6 toolkit mock — để UI bật/tắt + liệt kê tool
 * như toolkit thật, nhưng mô tả luôn gắn cờ [MOCK] để người dùng
 * không nhầm với kết nối live.
 */
export function createMockComposioV110AppDefinitions(): AppDefinition[] {
  return COMPOSIO_V110_MOCK_TOOLKITS.map((toolkit) => ({
    id: mockComposioV110AppId(toolkit.slug),
    label: toolkit.label,
    description: toolkit.description,
    icon: toolkit.icon,
    authType: 'composio',
    source: 'composio',
    toolkit: toolkit.slug,
    tools: toolkit.candidateToolSlugs.map((slug) => ({
      name: slug,
      description: `[MOCK] Tool Composio ${slug} — slug ứng viên chưa xác nhận live, chỉ chạy bằng dữ liệu mẫu local.`,
      needsApproval: mockComposioV110ToolNeedsApproval(slug),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Mock executor — dữ liệu mẫu xác định cho từng slug
// ---------------------------------------------------------------------------

export interface MockComposioV110Result {
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
  // Figma
  FIGMA_GET_FILE: { fileKey: 'mock-file-key', name: 'Mock Design File', lastModified: '2026-11-15T00:00:00Z', version: '1-mock' },
  FIGMA_LIST_PROJECT_FILES: { projectId: 'mock-project', files: ['mock-file-key'], total: 1 },
  FIGMA_GET_COMPONENTS: { fileKey: 'mock-file-key', components: ['Button/Primary', 'Card/Default'], total: 2 },
  FIGMA_GET_STYLES: { fileKey: 'mock-file-key', styles: ['Color/Brand', 'Text/Heading'], total: 2 },
  FIGMA_GET_FILE_COMMENTS: { fileKey: 'mock-file-key', comments: [{ author: 'mock-user', message: 'Mock comment' }], total: 1 },
  FIGMA_CREATE_COMMENT: { fileKey: 'mock-file-key', commentId: 'mock-comment-1', message: 'Mock comment created' },
  FIGMA_GET_TEAM_PROJECTS: { teamId: 'mock-team', projects: ['Mock Project'], total: 1 },
  FIGMA_GET_PROJECT_FILES: { projectId: 'mock-project', files: ['mock-file-key'], total: 1 },
  FIGMA_GET_FILE_NODES: { fileKey: 'mock-file-key', nodes: ['1:2', '1:3'], total: 2 },
  FIGMA_DOWNLOAD_FILE_IMAGES: { fileKey: 'mock-file-key', images: { '1:2': 'https://mock.invalid/figma/1-2.png' } },
  // Supabase
  SUPABASE_QUERY_TABLE: { table: 'mock_table', rows: [{ id: 1, name: 'Mock row' }], total: 1 },
  SUPABASE_LIST_TABLES: { tables: ['mock_table'], total: 1 },
  SUPABASE_INSERT_ROW: { table: 'mock_table', insertedId: 'mock-row-1', inserted: true },
  SUPABASE_UPDATE_ROW: { table: 'mock_table', updatedId: 'mock-row-1', updated: true },
  SUPABASE_DELETE_ROW: { table: 'mock_table', deletedId: 'mock-row-1', deleted: true },
  SUPABASE_LIST_USERS: { users: [{ id: 'mock-user-1', email: 'mock@example.com' }], total: 1 },
  SUPABASE_GET_USER: { id: 'mock-user-1', email: 'mock@example.com' },
  SUPABASE_LIST_BUCKETS: { buckets: ['mock-bucket'], total: 1 },
  SUPABASE_UPLOAD_FILE: { bucket: 'mock-bucket', path: 'mock/file.txt', uploaded: true },
  SUPABASE_LIST_STORAGE_FILES: { bucket: 'mock-bucket', files: ['mock/file.txt'], total: 1 },
  // Vercel
  VERCEL_LIST_DEPLOYMENTS: { deployments: [{ id: 'mock-deploy-1', url: 'mock-open-bot.vercel.app', state: 'READY' }], total: 1 },
  VERCEL_GET_DEPLOYMENT: { id: 'mock-deploy-1', url: 'mock-open-bot.vercel.app', state: 'READY' },
  VERCEL_LIST_PROJECTS: { projects: [{ id: 'mock-project-1', name: 'mock-open-bot' }], total: 1 },
  VERCEL_GET_PROJECT: { id: 'mock-project-1', name: 'mock-open-bot', framework: 'mock' },
  VERCEL_CREATE_DEPLOYMENT: { id: 'mock-deploy-2', url: 'mock-open-bot-2.vercel.app', state: 'QUEUED' },
  VERCEL_LIST_DOMAINS: { domains: ['mock.example.com'], total: 1 },
  VERCEL_GET_DOMAIN: { name: 'mock.example.com', verified: false },
  VERCEL_LIST_ENV_VARS: { vars: [{ key: 'MOCK_KEY', target: ['production'] }], total: 1 },
  VERCEL_CREATE_ENV_VAR: { key: 'MOCK_KEY', created: true },
  VERCEL_DELETE_DEPLOYMENT: { id: 'mock-deploy-1', deleted: true },
  // Todoist
  TODOIST_LIST_TASKS: { tasks: [{ id: 'mock-task-1', content: 'Mock task', priority: 1 }], total: 1 },
  TODOIST_GET_TASK: { id: 'mock-task-1', content: 'Mock task', priority: 1 },
  TODOIST_CREATE_TASK: { id: 'mock-task-2', content: 'Mock task created', created: true },
  TODOIST_UPDATE_TASK: { id: 'mock-task-1', updated: true },
  TODOIST_COMPLETE_TASK: { id: 'mock-task-1', completed: true },
  TODOIST_DELETE_TASK: { id: 'mock-task-1', deleted: true },
  TODOIST_LIST_PROJECTS: { projects: [{ id: 'mock-project-1', name: 'Mock Project' }], total: 1 },
  TODOIST_CREATE_PROJECT: { id: 'mock-project-2', name: 'Mock Project created', created: true },
  TODOIST_LIST_LABELS: { labels: ['mock-label'], total: 1 },
  TODOIST_SEARCH_TASKS: { query: 'mock', tasks: [{ id: 'mock-task-1', content: 'Mock task' }], total: 1 },
  // Intercom
  INTERCOM_LIST_CONVERSATIONS: { conversations: [{ id: 'mock-conv-1', state: 'open' }], total: 1 },
  INTERCOM_GET_CONVERSATION: { id: 'mock-conv-1', state: 'open', subject: 'Mock conversation' },
  INTERCOM_REPLY_CONVERSATION: { id: 'mock-conv-1', replied: true },
  INTERCOM_CLOSE_CONVERSATION: { id: 'mock-conv-1', state: 'closed' },
  INTERCOM_LIST_CONTACTS: { contacts: [{ id: 'mock-contact-1', email: 'mock@example.com' }], total: 1 },
  INTERCOM_GET_CONTACT: { id: 'mock-contact-1', email: 'mock@example.com' },
  INTERCOM_CREATE_CONTACT: { id: 'mock-contact-2', email: 'mock@example.com', created: true },
  INTERCOM_SEARCH_ARTICLES: { query: 'mock', articles: [{ id: 'mock-article-1', title: 'Mock article' }], total: 1 },
  INTERCOM_LIST_ADMINS: { admins: [{ id: 'mock-admin-1', name: 'Mock Admin' }], total: 1 },
  INTERCOM_CREATE_TICKET: { id: 'mock-ticket-1', created: true },
  // Miro
  MIRO_LIST_BOARDS: { boards: [{ id: 'mock-board-1', name: 'Mock Board' }], total: 1 },
  MIRO_GET_BOARD: { id: 'mock-board-1', name: 'Mock Board' },
  MIRO_CREATE_BOARD: { id: 'mock-board-2', name: 'Mock Board created', created: true },
  MIRO_LIST_BOARD_ITEMS: { boardId: 'mock-board-1', items: [{ id: 'mock-item-1', type: 'sticky_note' }], total: 1 },
  MIRO_CREATE_STICKY_NOTE: { boardId: 'mock-board-1', id: 'mock-item-2', type: 'sticky_note', created: true },
  MIRO_CREATE_SHAPE: { boardId: 'mock-board-1', id: 'mock-item-3', type: 'shape', created: true },
  MIRO_GET_BOARD_MEMBERS: { boardId: 'mock-board-1', members: [{ id: 'mock-user-1', role: 'editor' }], total: 1 },
  MIRO_SHARE_BOARD: { boardId: 'mock-board-1', shared: true },
  MIRO_DELETE_BOARD: { id: 'mock-board-1', deleted: true },
  MIRO_UPDATE_BOARD: { id: 'mock-board-1', updated: true },
};

function toolkitForSlug(slug: string): string | undefined {
  return COMPOSIO_V110_MOCK_TOOLKITS.find((t) => t.candidateToolSlugs.includes(slug))?.slug;
}

/** Hash xác định (FNV-1a 32-bit) — id mock ổn định theo input, không random. */
export function mockComposioV110DeterministicId(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Executor mock cho 6 toolkit v110. Thuần + đồng bộ + xác định:
 * không gọi mạng, không đọc Vault, không cần key. Slug lạ → throw
 * rõ ràng (fail-closed — mock không đoán tool nào không có trong
 * danh sách ứng viên).
 */
export class MockComposioV110Executor {
  /** Số lần execute đã chạy (để test đếm, không ảnh hưởng dữ liệu). */
  calls = 0;

  execute(slug: string, args: Record<string, unknown> = {}): MockComposioV110Result {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new Error('Mock Composio v110 cần slug không rỗng.');
    }
    const normalized = slug.trim();
    const toolkit = toolkitForSlug(normalized);
    if (toolkit === undefined) {
      throw new Error(
        `Slug "${normalized}" không thuộc toolkit mock v110 (figma/supabase/vercel/todoist/intercom/miro) — ` +
          `mock không thực thi slug lạ. Slug Composio thật phải đi qua Tool Router với key thật.`,
      );
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(`Mock Composio v110: args của "${normalized}" phải là object.`);
    }
    const sample = MOCK_SAMPLES[normalized];
    if (sample === undefined) {
      // Không thể xảy ra nếu candidateToolSlugs và MOCK_SAMPLES
      // đồng bộ — fail-closed thay vì trả object rỗng.
      throw new Error(`Slug mock "${normalized}" chưa có dữ liệu mẫu — thêm vào MOCK_SAMPLES trước.`);
    }
    this.calls += 1;
    const echo: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (!(key in sample)) echo[key] = value;
    }
    return {
      mock: true,
      live: false,
      toolkit,
      slug: normalized,
      data: {
        ...sample,
        // Id mock ổn định theo slug + args — cùng input luôn ra cùng id.
        mockId: `mock-${mockComposioV110DeterministicId(`${normalized}:${JSON.stringify(args)}`)}`,
        ...(Object.keys(echo).length > 0 ? { echo } : {}),
      },
      note: MOCK_LIVE_NOTE,
    };
  }
}

/** Chạy một tool mock (tiện cho tool layer — tạo executor mới mỗi lần gọi, không giữ state). */
export function executeMockComposioV110Tool(
  slug: string,
  args: Record<string, unknown> = {},
): MockComposioV110Result {
  return new MockComposioV110Executor().execute(slug, args);
}
