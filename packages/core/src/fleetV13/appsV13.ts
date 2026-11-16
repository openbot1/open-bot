/**
 * App integration mới v13 — 6 toolkit Composio mock-first
 * (v1.16, Đội T6).
 *
 * Nối tiếp `composio/toolkitsV114.ts` (6 toolkit mock: webflow,
 * pipedrive, chargebee, xero, eventbrite, surveymonkey — mỗi toolkit
 * 10 slug ứng viên). V13 thêm 6 toolkit CHƯA CÓ trong repo (đã đối
 * chiếu slug với `composio/toolkits*.ts` ngày 16/11/2026, không
 * trùng): docusign (ký số), freshbooks (kế toán nhỏ), gong (ghi âm
 * + phân tích sales call), lever (tuyển dụng ATS), quickbooks (kế
 * toán), resend (gửi email transactional).
 *
 * Quy ước giống V114, KHÔNG copy code V114:
 * - Mỗi toolkit: slug + tên hiển thị + mô tả + 8–10 tool ứng viên
 *   theo quy ước đặt tên Composio (PREFIX_VERB_NOUN). Slug/tool là
 *   ỨNG VIÊN — chưa đối chiếu với API thật của Composio, chưa được
 *   bật live. Bật live cần key thật + xác nhận slug (xem ghi chú
 *   từng toolkit).
 * - Mock-first: `COMPOSIO_V13_MOCK_RESPONSES` trả dữ liệu mẫu có
 *   nhãn `mock-` để agent loop + UI + test chạy end-to-end mà không
 *   cần key thật, không gọi mạng. Mock KHÔNG bao giờ được trình bày
 *   như dữ liệu thật — response nào cũng có `mock: true`.
 * - Per-app health + quota: `ComposioV13AppHealth` (trạng thái kết
 *   nối, độ trễ lần check cuối, lỗi gần nhất) và
 *   `ComposioV13AppQuota` (giới hạn/tháng, đã dùng, reset, cảnh báo
 *   80%). Health/quota là dữ liệu do caller đo/cập nhật — module
 *   chỉ tính toán + validate, không tự gọi Composio.
 *
 * Module này KHÔNG gọi mạng, KHÔNG chứa key thật, KHÔNG tự bật
 * live: nó định nghĩa "app nào, tool nào, mock ra sao, khỏe không,
 * còn quota không".
 */

/** Slug ứng viên của 6 toolkit mới v13 (chưa đối chiếu live). */
export const COMPOSIO_V13_TOOLKIT_SLUGS: readonly string[] = [
  'docusign',
  'freshbooks',
  'gong',
  'lever',
  'quickbooks',
  'resend',
];

/** Một tool ứng viên trong một toolkit. */
export interface ComposioV13ToolkitTool {
  /** Tên action theo quy ước Composio, vd `DOCUSIGN_SEND_ENVELOPE`. */
  action: string;
  /** Mô tả ngắn cho agent/UI. */
  description: string;
  /** true = hành động ghi (cần duyệt trước khi chạy thật). */
  write: boolean;
}

/** Định nghĩa một toolkit app mới v13. */
export interface ComposioV13Toolkit {
  slug: string;
  displayName: string;
  category: string;
  description: string;
  /** Ghi chú live: slug ứng viên, chưa đối chiếu API thật. */
  liveNote: string;
  tools: ComposioV13ToolkitTool[];
}

function liveNote(displayName: string): string {
  return (
    `[MOCK] Đọc/tạo dữ liệu ${displayName} qua Composio. Chưa gọi API thật: ` +
    `Vault chưa có Composio API key, slug ứng viên chưa đối chiếu live. ` +
    `Bật live cần key thật + xác nhận slug (xem ghi chú đầu file).`
  );
}

function tool(action: string, description: string, write = false): ComposioV13ToolkitTool {
  return { action, description, write };
}

/** 6 toolkit mới v13 — 8–10 tool ứng viên mỗi toolkit. */
export const COMPOSIO_V13_TOOLKITS: readonly ComposioV13Toolkit[] = [
  {
    slug: 'docusign',
    displayName: 'DocuSign',
    category: 'e-signature',
    description: 'Gửi và theo dõi tài liệu cần ký số (envelope, template, người nhận).',
    liveNote: liveNote('DocuSign'),
    tools: [
      tool('DOCUSIGN_SEND_ENVELOPE', 'Gửi envelope (tài liệu + người ký) để ký số.', true),
      tool('DOCUSIGN_LIST_ENVELOPES', 'Liệt kê envelope theo trạng thái (sent/completed/voided).'),
      tool('DOCUSIGN_GET_ENVELOPE', 'Lấy chi tiết một envelope (người ký, trạng thái từng người).'),
      tool('DOCUSIGN_LIST_TEMPLATES', 'Liệt kê template envelope có sẵn.'),
      tool('DOCUSIGN_GET_TEMPLATE', 'Lấy chi tiết một template.'),
      tool('DOCUSIGN_VOID_ENVELOPE', 'Hủy một envelope chưa hoàn tất.', true),
      tool('DOCUSIGN_DOWNLOAD_DOCUMENT', 'Tải tài liệu đã ký của một envelope.'),
      tool('DOCUSIGN_LIST_RECIPIENTS', 'Liệt kê người nhận của một envelope.'),
      tool('DOCUSIGN_CREATE_CORRECT_VIEW', 'Tạo link sửa envelope (correct view) cho người gửi.', true),
    ],
  },
  {
    slug: 'freshbooks',
    displayName: 'FreshBooks',
    category: 'accounting',
    description: 'Hóa đơn, khách hàng, chi phí và thanh toán cho doanh nghiệp nhỏ.',
    liveNote: liveNote('FreshBooks'),
    tools: [
      tool('FRESHBOOKS_LIST_INVOICES', 'Liệt kê hóa đơn theo trạng thái/khách hàng.'),
      tool('FRESHBOOKS_GET_INVOICE', 'Lấy chi tiết một hóa đơn.'),
      tool('FRESHBOOKS_CREATE_INVOICE', 'Tạo hóa đơn mới cho khách hàng.', true),
      tool('FRESHBOOKS_SEND_INVOICE', 'Gửi hóa đơn cho khách hàng.', true),
      tool('FRESHBOOKS_LIST_CLIENTS', 'Liệt kê khách hàng.'),
      tool('FRESHBOOKS_GET_CLIENT', 'Lấy chi tiết một khách hàng.'),
      tool('FRESHBOOKS_CREATE_CLIENT', 'Tạo khách hàng mới.', true),
      tool('FRESHBOOKS_LIST_PAYMENTS', 'Liệt kê thanh toán đã nhận.'),
      tool('FRESHBOOKS_LIST_EXPENSES', 'Liệt kê chi phí theo khoảng thời gian.'),
      tool('FRESHBOOKS_CREATE_EXPENSE', 'Ghi một chi phí mới.', true),
    ],
  },
  {
    slug: 'gong',
    displayName: 'Gong',
    category: 'sales-intelligence',
    description: 'Ghi âm, transcript và phân tích cuộc gọi bán hàng (deal, người tham gia).',
    liveNote: liveNote('Gong'),
    tools: [
      tool('GONG_LIST_CALLS', 'Liệt kê cuộc gọi đã ghi theo khoảng thời gian.'),
      tool('GONG_GET_CALL_TRANSCRIPT', 'Lấy transcript của một cuộc gọi.'),
      tool('GONG_GET_CALL_DETAILS', 'Lấy chi tiết cuộc gọi (người tham gia, thời lượng, chủ đề).'),
      tool('GONG_LIST_CALLS_BY_DEAL', 'Liệt kê cuộc gọi thuộc một deal.'),
      tool('GONG_SEARCH_CALLS', 'Tìm cuộc gọi theo từ khóa trong transcript.'),
      tool('GONG_GET_CALL_INSIGHTS', 'Lấy insight cuộc gọi (câu hỏi, rủi ro, next step).'),
      tool('GONG_LIST_USERS', 'Liệt kê user Gong (nhân viên bán hàng).'),
      tool('GONG_GET_USER_STATS', 'Lấy thống kê cuộc gọi của một user.'),
    ],
  },
  {
    slug: 'lever',
    displayName: 'Lever',
    category: 'recruiting',
    description: 'ATS tuyển dụng: cơ hội ứng viên, vị trí mở, giai đoạn phỏng vấn.',
    liveNote: liveNote('Lever'),
    tools: [
      tool('LEVER_LIST_OPPORTUNITIES', 'Liệt kê ứng viên (opportunity) theo giai đoạn.'),
      tool('LEVER_GET_OPPORTUNITY', 'Lấy chi tiết một ứng viên.'),
      tool('LEVER_CREATE_OPPORTUNITY', 'Tạo ứng viên mới từ hồ sơ.', true),
      tool('LEVER_LIST_POSTINGS', 'Liệt kê vị trí đang tuyển.'),
      tool('LEVER_GET_POSTING', 'Lấy chi tiết một vị trí.'),
      tool('LEVER_ADD_NOTE', 'Thêm ghi chú vào hồ sơ ứng viên.', true),
      tool('LEVER_ADVANCE_STAGE', 'Chuyển ứng viên sang giai đoạn tiếp theo.', true),
      tool('LEVER_LIST_STAGES', 'Liệt kê các giai đoạn tuyển dụng.'),
      tool('LEVER_ARCHIVE_OPPORTUNITY', 'Lưu trữ (từ chối) một ứng viên.', true),
    ],
  },
  {
    slug: 'quickbooks',
    displayName: 'QuickBooks',
    category: 'accounting',
    description: 'Kế toán: hóa đơn, khách hàng, nhà cung cấp, báo cáo lãi lỗ.',
    liveNote: liveNote('QuickBooks'),
    tools: [
      tool('QUICKBOOKS_LIST_INVOICES', 'Liệt kê hóa đơn QuickBooks.'),
      tool('QUICKBOOKS_GET_INVOICE', 'Lấy chi tiết một hóa đơn.'),
      tool('QUICKBOOKS_CREATE_INVOICE', 'Tạo hóa đơn mới.', true),
      tool('QUICKBOOKS_LIST_CUSTOMERS', 'Liệt kê khách hàng.'),
      tool('QUICKBOOKS_CREATE_CUSTOMER', 'Tạo khách hàng mới.', true),
      tool('QUICKBOOKS_LIST_VENDORS', 'Liệt kê nhà cung cấp.'),
      tool('QUICKBOOKS_LIST_PAYMENTS', 'Liệt kê thanh toán.'),
      tool('QUICKBOOKS_GET_PROFIT_LOSS', 'Lấy báo cáo lãi lỗ theo khoảng thời gian.'),
      tool('QUICKBOOKS_LIST_ACCOUNTS', 'Liệt kê tài khoản kế toán (chart of accounts).'),
      tool('QUICKBOOKS_CREATE_BILL', 'Tạo bill nhà cung cấp mới.', true),
    ],
  },
  {
    slug: 'resend',
    displayName: 'Resend',
    category: 'email',
    description: 'Gửi email transactional (xác nhận, thông báo) qua API Resend.',
    liveNote: liveNote('Resend'),
    tools: [
      tool('RESEND_SEND_EMAIL', 'Gửi một email (to/subject/html/text).', true),
      tool('RESEND_LIST_EMAILS', 'Liệt kê email đã gửi gần đây.'),
      tool('RESEND_GET_EMAIL', 'Lấy trạng thái/truy vấn một email đã gửi.'),
      tool('RESEND_LIST_DOMAINS', 'Liệt kê domain đã xác thực.'),
      tool('RESEND_GET_DOMAIN', 'Lấy chi tiết một domain.'),
      tool('RESEND_LIST_API_KEYS', 'Liệt kê API key Resend (metadata, không kèm secret).'),
      tool('RESEND_LIST_AUDIENCES', 'Liệt kê audience (danh sách liên hệ).'),
      tool('RESEND_LIST_CONTACTS', 'Liệt kê contact trong một audience.'),
    ],
  },
];

/** Tìm toolkit theo slug (không phân biệt hoa thường). */
export function findComposioV13Toolkit(slug: string): ComposioV13Toolkit | null {
  if (typeof slug !== 'string' || !slug.trim()) return null;
  const id = slug.trim().toLowerCase();
  return COMPOSIO_V13_TOOLKITS.find((t) => t.slug === id) ?? null;
}

/** Tìm tool theo action (vd `DOCUSIGN_SEND_ENVELOPE`). */
export function findComposioV13Tool(action: string): {
  toolkit: ComposioV13Toolkit;
  tool: ComposioV13ToolkitTool;
} | null {
  if (typeof action !== 'string' || !action.trim()) return null;
  const id = action.trim().toUpperCase();
  for (const toolkit of COMPOSIO_V13_TOOLKITS) {
    const toolDef = toolkit.tools.find((t) => t.action === id);
    if (toolDef) return { toolkit, tool: toolDef };
  }
  return null;
}

/** Tổng số tool ứng viên v13 (dùng để pin số đếm trong test). */
export function composioV13ToolCount(): number {
  return COMPOSIO_V13_TOOLKITS.reduce((n, t) => n + t.tools.length, 0);
}

/** Số tool ghi (cần duyệt) trong toàn bộ v13. */
export function composioV13WriteToolCount(): number {
  return COMPOSIO_V13_TOOLKITS.reduce(
    (n, t) => n + t.tools.filter((toolDef) => toolDef.write).length,
    0,
  );
}

/** Validate định nghĩa toolkit (slug/action trùng, thiếu mô tả...). */
export function validateComposioV13Toolkits(): string[] {
  const errors: string[] = [];
  const seenSlugs = new Set<string>();
  const seenActions = new Set<string>();
  for (const toolkit of COMPOSIO_V13_TOOLKITS) {
    if (seenSlugs.has(toolkit.slug)) errors.push(`slug trùng: ${toolkit.slug}`);
    seenSlugs.add(toolkit.slug);
    if (!toolkit.displayName.trim()) errors.push(`toolkit ${toolkit.slug} thiếu displayName`);
    if (toolkit.tools.length === 0) errors.push(`toolkit ${toolkit.slug} không có tool nào`);
    for (const toolDef of toolkit.tools) {
      if (seenActions.has(toolDef.action)) errors.push(`action trùng: ${toolDef.action}`);
      seenActions.add(toolDef.action);
      if (!toolDef.action.startsWith(`${toolkit.slug.toUpperCase()}_`)) {
        errors.push(`action ${toolDef.action} không có prefix ${toolkit.slug.toUpperCase()}_`);
      }
      if (!toolDef.description.trim()) errors.push(`tool ${toolDef.action} thiếu description`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Mock responses (mock-first, có nhãn mock: true)
// ---------------------------------------------------------------------------

/** Mock response cho một action (dữ liệu mẫu, KHÔNG phải dữ liệu thật). */
export const COMPOSIO_V13_MOCK_RESPONSES: Readonly<Record<string, Record<string, unknown>>> = {
  DOCUSIGN_LIST_ENVELOPES: {
    mock: true,
    envelopes: [{ id: 'mock-env-1', status: 'sent', subject: 'Mock NDA' }],
    total: 1,
  },
  DOCUSIGN_GET_ENVELOPE: {
    mock: true,
    id: 'mock-env-1',
    status: 'sent',
    recipients: [{ name: 'Mock Signer', status: 'sent' }],
  },
  DOCUSIGN_SEND_ENVELOPE: { mock: true, id: 'mock-env-2', status: 'sent', created: true },
  DOCUSIGN_LIST_TEMPLATES: {
    mock: true,
    templates: [{ id: 'mock-tpl-1', name: 'Mock NDA template' }],
    total: 1,
  },
  DOCUSIGN_VOID_ENVELOPE: { mock: true, id: 'mock-env-1', voided: true },
  DOCUSIGN_DOWNLOAD_DOCUMENT: { mock: true, id: 'mock-env-1', downloaded: true },
  DOCUSIGN_LIST_RECIPIENTS: {
    mock: true,
    recipients: [{ name: 'Mock Signer', status: 'sent' }],
    total: 1,
  },
  DOCUSIGN_GET_TEMPLATE: { mock: true, id: 'mock-tpl-1', name: 'Mock NDA template' },
  DOCUSIGN_CREATE_CORRECT_VIEW: { mock: true, url: 'https://mock.invalid/docusign/correct' },
  FRESHBOOKS_LIST_INVOICES: {
    mock: true,
    invoices: [{ id: 'mock-inv-1', status: 'outstanding', amount: 1000 }],
    total: 1,
  },
  FRESHBOOKS_GET_INVOICE: { mock: true, id: 'mock-inv-1', status: 'outstanding', amount: 1000 },
  FRESHBOOKS_CREATE_INVOICE: { mock: true, id: 'mock-inv-2', created: true },
  FRESHBOOKS_SEND_INVOICE: { mock: true, id: 'mock-inv-1', sent: true },
  FRESHBOOKS_LIST_CLIENTS: {
    mock: true,
    clients: [{ id: 'mock-client-1', name: 'Mock Client' }],
    total: 1,
  },
  FRESHBOOKS_GET_CLIENT: { mock: true, id: 'mock-client-1', name: 'Mock Client' },
  FRESHBOOKS_CREATE_CLIENT: { mock: true, id: 'mock-client-2', created: true },
  FRESHBOOKS_LIST_PAYMENTS: {
    mock: true,
    payments: [{ id: 'mock-pay-1', amount: 1000 }],
    total: 1,
  },
  FRESHBOOKS_LIST_EXPENSES: {
    mock: true,
    expenses: [{ id: 'mock-exp-1', amount: 50 }],
    total: 1,
  },
  FRESHBOOKS_CREATE_EXPENSE: { mock: true, id: 'mock-exp-2', created: true },
  GONG_LIST_CALLS: {
    mock: true,
    calls: [{ id: 'mock-call-1', title: 'Mock sales call', durationSec: 1800 }],
    total: 1,
  },
  GONG_GET_CALL_TRANSCRIPT: {
    mock: true,
    id: 'mock-call-1',
    transcript: [{ speaker: 'Mock Rep', text: 'Mock transcript line.' }],
  },
  GONG_GET_CALL_DETAILS: { mock: true, id: 'mock-call-1', durationSec: 1800, participants: 2 },
  GONG_LIST_CALLS_BY_DEAL: {
    mock: true,
    calls: [{ id: 'mock-call-1', title: 'Mock sales call' }],
    total: 1,
  },
  GONG_SEARCH_CALLS: {
    mock: true,
    calls: [{ id: 'mock-call-1', title: 'Mock sales call' }],
    total: 1,
  },
  GONG_GET_CALL_INSIGHTS: {
    mock: true,
    id: 'mock-call-1',
    insights: ['Mock next step: send proposal.'],
  },
  GONG_LIST_USERS: {
    mock: true,
    users: [{ id: 'mock-user-1', name: 'Mock Rep' }],
    total: 1,
  },
  GONG_GET_USER_STATS: { mock: true, id: 'mock-user-1', calls: 12, talkRatio: 0.5 },
  LEVER_LIST_OPPORTUNITIES: {
    mock: true,
    opportunities: [{ id: 'mock-opp-1', name: 'Mock Candidate', stage: 'phone-screen' }],
    total: 1,
  },
  LEVER_GET_OPPORTUNITY: { mock: true, id: 'mock-opp-1', name: 'Mock Candidate', stage: 'phone-screen' },
  LEVER_CREATE_OPPORTUNITY: { mock: true, id: 'mock-opp-2', created: true },
  LEVER_LIST_POSTINGS: {
    mock: true,
    postings: [{ id: 'mock-post-1', title: 'Mock Engineer' }],
    total: 1,
  },
  LEVER_GET_POSTING: { mock: true, id: 'mock-post-1', title: 'Mock Engineer' },
  LEVER_ADD_NOTE: { mock: true, id: 'mock-opp-1', noted: true },
  LEVER_ADVANCE_STAGE: { mock: true, id: 'mock-opp-1', stage: 'onsite', advanced: true },
  LEVER_LIST_STAGES: { mock: true, stages: ['phone-screen', 'onsite', 'offer'] },
  LEVER_ARCHIVE_OPPORTUNITY: { mock: true, id: 'mock-opp-1', archived: true },
  QUICKBOOKS_LIST_INVOICES: {
    mock: true,
    invoices: [{ id: 'mock-qb-inv-1', amount: 2500 }],
    total: 1,
  },
  QUICKBOOKS_GET_INVOICE: { mock: true, id: 'mock-qb-inv-1', amount: 2500 },
  QUICKBOOKS_CREATE_INVOICE: { mock: true, id: 'mock-qb-inv-2', created: true },
  QUICKBOOKS_LIST_CUSTOMERS: {
    mock: true,
    customers: [{ id: 'mock-qb-cust-1', name: 'Mock Customer' }],
    total: 1,
  },
  QUICKBOOKS_CREATE_CUSTOMER: { mock: true, id: 'mock-qb-cust-2', created: true },
  QUICKBOOKS_LIST_VENDORS: {
    mock: true,
    vendors: [{ id: 'mock-qb-vendor-1', name: 'Mock Vendor' }],
    total: 1,
  },
  QUICKBOOKS_LIST_PAYMENTS: {
    mock: true,
    payments: [{ id: 'mock-qb-pay-1', amount: 2500 }],
    total: 1,
  },
  QUICKBOOKS_GET_PROFIT_LOSS: { mock: true, income: 10000, expenses: 4000, netIncome: 6000 },
  QUICKBOOKS_LIST_ACCOUNTS: {
    mock: true,
    accounts: [{ id: 'mock-qb-acc-1', name: 'Mock Checking' }],
    total: 1,
  },
  QUICKBOOKS_CREATE_BILL: { mock: true, id: 'mock-qb-bill-2', created: true },
  RESEND_SEND_EMAIL: { mock: true, id: 'mock-email-2', sent: true },
  RESEND_LIST_EMAILS: {
    mock: true,
    emails: [{ id: 'mock-email-1', status: 'delivered' }],
    total: 1,
  },
  RESEND_GET_EMAIL: { mock: true, id: 'mock-email-1', status: 'delivered' },
  RESEND_LIST_DOMAINS: {
    mock: true,
    domains: [{ id: 'mock-domain-1', name: 'mock.example' }],
    total: 1,
  },
  RESEND_GET_DOMAIN: { mock: true, id: 'mock-domain-1', name: 'mock.example', verified: true },
  RESEND_LIST_API_KEYS: {
    mock: true,
    apiKeys: [{ id: 'mock-key-1', name: 'Mock key' }],
    total: 1,
  },
  RESEND_LIST_AUDIENCES: {
    mock: true,
    audiences: [{ id: 'mock-aud-1', name: 'Mock audience' }],
    total: 1,
  },
  RESEND_LIST_CONTACTS: {
    mock: true,
    contacts: [{ id: 'mock-contact-1', email: 'mock@example.com' }],
    total: 1,
  },
};

/** Lấy mock response cho một action (null khi action không có mock). */
export function composioV13MockResponse(action: string): Record<string, unknown> | null {
  if (typeof action !== 'string') return null;
  const hit = COMPOSIO_V13_MOCK_RESPONSES[action.trim().toUpperCase()];
  return hit ? { ...hit } : null;
}

/** True khi mọi tool v13 đều có mock response (để test pin). */
export function composioV13AllToolsHaveMocks(): boolean {
  return COMPOSIO_V13_TOOLKITS.every((t) =>
    t.tools.every((toolDef) => toolDef.action in COMPOSIO_V13_MOCK_RESPONSES),
  );
}

// ---------------------------------------------------------------------------
// Per-app health + quota
// ---------------------------------------------------------------------------

/** Trạng thái sức khỏe của một app integration. */
export type ComposioV13AppHealthStatus = 'healthy' | 'degraded' | 'down' | 'not-connected' | 'unknown';

export const COMPOSIO_V13_APP_HEALTH_STATUSES: readonly ComposioV13AppHealthStatus[] = [
  'healthy',
  'degraded',
  'down',
  'not-connected',
  'unknown',
];

/** Sức khỏe của một app (do caller đo bằng probe thật/mock, module chỉ xét). */
export interface ComposioV13AppHealth {
  slug: string;
  status: ComposioV13AppHealthStatus;
  /** Độ trễ probe cuối (ms, null = chưa probe lần nào). */
  lastLatencyMs: number | null;
  /** Epoch ms probe thành công gần nhất (null = chưa từng). */
  lastOkAt: number | null;
  /** Epoch ms probe gần nhất (null = chưa probe). */
  lastCheckedAt: number | null;
  /** Lỗi gần nhất (thông điệp ngắn, không chứa secret). */
  lastError: string;
  /** Số lỗi liên tiếp. */
  consecutiveErrors: number;
}

/** Quota của một app (giới hạn do Composio/nhà cung cấp đặt). */
export interface ComposioV13AppQuota {
  slug: string;
  /** Giới hạn gọi API trong kỳ (0 = không giới hạn/không biết). */
  limitPerPeriod: number;
  /** Đã dùng trong kỳ hiện tại. */
  usedInPeriod: number;
  /** Kỳ quota: 'day' | 'month'. */
  period: 'day' | 'month';
  /** Epoch ms kỳ hiện tại reset (null = không biết). */
  resetAt: number | null;
}

/** Ngưỡng cảnh báo quota: 80% (mặc định). */
export const COMPOSIO_V13_QUOTA_WARN_FRACTION = 0.8;

/** Tạo health mặc định cho một app (chưa kết nối). */
export function createComposioV13AppHealth(slug: string): ComposioV13AppHealth {
  return {
    slug: slug.trim().toLowerCase(),
    status: 'not-connected',
    lastLatencyMs: null,
    lastOkAt: null,
    lastCheckedAt: null,
    lastError: '',
    consecutiveErrors: 0,
  };
}

/** Tạo quota mặc định cho một app (không giới hạn). */
export function createComposioV13AppQuota(
  slug: string,
  period: 'day' | 'month' = 'month',
): ComposioV13AppQuota {
  return { slug: slug.trim().toLowerCase(), limitPerPeriod: 0, usedInPeriod: 0, period, resetAt: null };
}

/**
 * Cập nhật health sau một lần probe: probe ok (latency hợp lệ) →
 * healthy khi latency < 2000ms, degraded khi chậm hơn; probe lỗi →
 * tăng lỗi liên tiếp, 3 lỗi liên tiếp → down. Hàm thuần.
 */
export function updateComposioV13AppHealth(
  health: ComposioV13AppHealth,
  probe: { ok: boolean; latencyMs?: number; error?: string },
  now = Date.now(),
): ComposioV13AppHealth {
  if (probe.ok) {
    const latency = typeof probe.latencyMs === 'number' ? Math.max(0, Math.floor(probe.latencyMs)) : null;
    return {
      ...health,
      status: latency !== null && latency >= 2000 ? 'degraded' : 'healthy',
      lastLatencyMs: latency,
      lastOkAt: now,
      lastCheckedAt: now,
      lastError: '',
      consecutiveErrors: 0,
    };
  }
  const consecutiveErrors = health.consecutiveErrors + 1;
  return {
    ...health,
    status: consecutiveErrors >= 3 ? 'down' : 'degraded',
    lastCheckedAt: now,
    lastError: (probe.error ?? 'probe lỗi').slice(0, 300),
    consecutiveErrors,
  };
}

/** Tỉ lệ quota đã dùng (null khi không có giới hạn). */
export function composioV13QuotaFraction(quota: ComposioV13AppQuota): number | null {
  if (quota.limitPerPeriod <= 0) return null;
  return Math.min(1, Math.max(0, quota.usedInPeriod / quota.limitPerPeriod));
}

/** True khi app đã dùng >= 80% quota (cảnh báo) hoặc đã hết quota. */
export function composioV13QuotaWarning(quota: ComposioV13AppQuota): {
  warned: boolean;
  exhausted: boolean;
  detail: string;
} {
  const fraction = composioV13QuotaFraction(quota);
  if (fraction === null) {
    return { warned: false, exhausted: false, detail: 'không có giới hạn quota' };
  }
  if (fraction >= 1) {
    return { warned: true, exhausted: true, detail: `đã hết quota (${quota.usedInPeriod}/${quota.limitPerPeriod})` };
  }
  if (fraction >= COMPOSIO_V13_QUOTA_WARN_FRACTION) {
    return {
      warned: true,
      exhausted: false,
      detail: `đã dùng ${(fraction * 100).toFixed(0)}% quota (${quota.usedInPeriod}/${quota.limitPerPeriod}) — gần hết`,
    };
  }
  return {
    warned: false,
    exhausted: false,
    detail: `đã dùng ${(fraction * 100).toFixed(0)}% quota (${quota.usedInPeriod}/${quota.limitPerPeriod})`,
  };
}

/** Ghi nhận một lần gọi API (tăng used, chặn khi hết quota). */
export type ComposioV13QuotaRecordResult =
  | { ok: true; quota: ComposioV13AppQuota }
  | { ok: false; quota: ComposioV13AppQuota; error: string };

export function recordComposioV13QuotaUse(
  quota: ComposioV13AppQuota,
  calls = 1,
): ComposioV13QuotaRecordResult {
  if (!Number.isFinite(calls) || calls <= 0) {
    return { ok: false, quota, error: 'calls phải > 0' };
  }
  if (quota.limitPerPeriod > 0 && quota.usedInPeriod + calls > quota.limitPerPeriod) {
    return {
      ok: false,
      quota,
      error: `hết quota ${quota.slug}: ${quota.usedInPeriod}/${quota.limitPerPeriod} (thêm ${calls} sẽ vượt)`,
    };
  }
  return { ok: true, quota: { ...quota, usedInPeriod: quota.usedInPeriod + Math.floor(calls) } };
}

/** Tóm tắt toàn bộ app v13 cho UI: health + quota theo app. */
export interface ComposioV13AppsSummary {
  appCount: number;
  toolCount: number;
  healthyCount: number;
  downCount: number;
  notConnectedCount: number;
  quotaWarned: string[];
  quotaExhausted: string[];
  summary: string;
}

export function summarizeComposioV13Apps(
  healths: readonly ComposioV13AppHealth[],
  quotas: readonly ComposioV13AppQuota[],
): ComposioV13AppsSummary {
  const healthyCount = healths.filter((h) => h.status === 'healthy').length;
  const downCount = healths.filter((h) => h.status === 'down').length;
  const notConnectedCount = healths.filter((h) => h.status === 'not-connected').length;
  const quotaWarned: string[] = [];
  const quotaExhausted: string[] = [];
  for (const q of quotas) {
    const w = composioV13QuotaWarning(q);
    if (w.exhausted) quotaExhausted.push(q.slug);
    else if (w.warned) quotaWarned.push(q.slug);
  }
  return {
    appCount: COMPOSIO_V13_TOOLKITS.length,
    toolCount: composioV13ToolCount(),
    healthyCount,
    downCount,
    notConnectedCount,
    quotaWarned,
    quotaExhausted,
    summary:
      `${COMPOSIO_V13_TOOLKITS.length} app mới v13 (${composioV13ToolCount()} tool mock-first): ` +
      `${healthyCount} healthy, ${downCount} down, ${notConnectedCount} chưa kết nối; ` +
      `${quotaWarned.length} app gần hết quota, ${quotaExhausted.length} app hết quota.`,
  };
}
