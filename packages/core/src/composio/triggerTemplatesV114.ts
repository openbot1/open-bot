/**
 * Composio trigger templates v2 (v1.14, Doi T4) — catalog mo rong.
 *
 * `triggers.ts` (v0.83) chi co 4 field moi trigger (toolkit/slug/
 * name/delivery) — du de chon trigger trong UI nhung khong du de
 * nguoi dung biet trigger tra ve DU LIEU GI. Module nay them, cho
 * moi template: mo ta (de lam gi), input schema (cac field trong
 * `data` cua event + kieu + bat buoc hay khong), va vi du payload
 * that (de user/automation biet cach doc event ma khong can mo
 * docs Composio).
 *
 * NGUON SLUG — trung thuc nhu v110-v112:
 * - 29 template `source: 'curated'`: slug lay NGUYEN VEN tu
 *   `COMPOSIO_TRIGGER_DEFS` trong `triggers.ts` (da doi chieu voi
 *   catalog live `GET /api/v3.1/triggers_types` ngay 2026-11-11).
 *   Module nay KHONG them slug moi vao `COMPOSIO_TRIGGER_DEFS`
 *   nen pin `COMPOSIO_TRIGGER_TOTAL_COUNT = 447` khong doi.
 * - 6 template `source: 'candidate'`: slug ung vien cho 6 toolkit
 *   mock v114 (webflow/pipedrive/chargebee/xero/eventbrite/
 *   surveymonkey), dat theo quy uoc dat ten Composio, CHUA doi
 *   chieu live — chi dung de thiet ke automation truoc, bat live
 *   can xac nhan slug nhu cac toolkit mock v114.
 *
 * Template KHONG tao trigger instance trong Composio (user tao
 * trong dashboard/SDK nhu truoc) — no chi mo ta event de
 * automation/triggerMapping doc duoc.
 */

import { COMPOSIO_TRIGGER_DEFS } from './triggers';

/** Nhom cong viec cua template (de loc trong UI). */
export type ComposioV114TriggerCategory =
  | 'communication'
  | 'code'
  | 'project'
  | 'sales'
  | 'support'
  | 'calendar'
  | 'document'
  | 'billing'
  | 'marketing';

/** Kieu du lieu cua mot field trong payload event. */
export type ComposioV114TriggerFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/** Mot field trong `data` cua event. */
export interface ComposioV114TriggerField {
  /** Ten field trong payload, vd 'subject'. */
  name: string;
  /** Kieu du lieu. */
  type: ComposioV114TriggerFieldType;
  /** Field co luon co trong moi event khong. */
  required: boolean;
  /** Mo ta ngan field dung de lam gi. */
  description: string;
}

/** Nguon cua slug trong template. */
export type ComposioV114TemplateSource = 'curated' | 'candidate';

/** Mot trigger template v114: day du thong tin de hieu + dung event. */
export interface ComposioV114TriggerTemplate {
  /** Slug toolkit, vd 'gmail'. */
  toolkit: string;
  /** Slug trigger, vd 'GMAIL_NEW_GMAIL_MESSAGE'. */
  slug: string;
  /** Ten hien thi (tu catalog Composio doi voi curated). */
  name: string;
  /** Cach Composio biet ve event: realtime push hay polling. */
  delivery: 'webhook' | 'poll';
  /** Nhom cong viec (de loc). */
  category: ComposioV114TriggerCategory;
  /** Mo ta: event nay xay ra khi nao, dung de lam gi. */
  description: string;
  /** Schema cac field trong `data` cua event. */
  fields: ComposioV114TriggerField[];
  /** Vi du payload `data` (gia tri mau, khong phai du lieu that). */
  examplePayload: Record<string, unknown>;
  /** 'curated' = slug da xac nhan live; 'candidate' = slug ung vien. */
  source: ComposioV114TemplateSource;
}

function f(
  name: string,
  type: ComposioV114TriggerFieldType,
  required: boolean,
  description: string,
): ComposioV114TriggerField {
  return { name, type, required, description };
}

/**
 * 35 trigger template v114 — 29 curated (slug da xac nhan trong
 * COMPOSIO_TRIGGER_DEFS) + 6 candidate (toolkit mock v114).
 */
export const COMPOSIO_V114_TRIGGER_TEMPLATES: readonly ComposioV114TriggerTemplate[] = [
  // --- Communication: Gmail / Slack / Discord / Outlook -----------------
  {
    toolkit: 'gmail',
    slug: 'GMAIL_NEW_GMAIL_MESSAGE',
    name: 'New Gmail Message Received Trigger',
    delivery: 'poll',
    category: 'communication',
    description:
      'Co email moi vao hop thu. Dung de tom tat email, tra loi tu dong, tao task tu email, hoac bao cho user khi co mail tu nguoi quan trong.',
    fields: [
      f('message_id', 'string', true, 'Id duy nhat cua email trong Gmail.'),
      f('subject', 'string', true, 'Tieu de email.'),
      f('sender', 'string', true, 'Dia chi email nguoi gui.'),
      f('snippet', 'string', false, 'Doan mo dau ngan cua noi dung email.'),
      f('labels', 'array', false, 'Nhan Gmail gan cho email (vd INBOX, IMPORTANT).'),
    ],
    examplePayload: {
      message_id: 'msg_mock_001',
      subject: 'Mock: bao gia thang 11',
      sender: 'mock-sender@example.com',
      snippet: 'Chao ban, day la bao gia...',
      labels: ['INBOX'],
    },
    source: 'curated',
  },
  {
    toolkit: 'gmail',
    slug: 'GMAIL_EMAIL_SENT_TRIGGER',
    name: 'Email Sent',
    delivery: 'poll',
    category: 'communication',
    description:
      'Mot email vua duoc gui di tu hop thu nay. Dung de ghi log email da gui, cap nhat CRM, hoac bao khi email gui cho khach hang quan trong.',
    fields: [
      f('message_id', 'string', true, 'Id duy nhat cua email da gui.'),
      f('subject', 'string', true, 'Tieu de email da gui.'),
      f('recipient', 'string', true, 'Dia chi email nguoi nhan.'),
      f('thread_id', 'string', false, 'Id thread de nhom email cung chuoi hoi dap.'),
    ],
    examplePayload: {
      message_id: 'msg_mock_002',
      subject: 'Re: Mock: bao gia thang 11',
      recipient: 'mock-client@example.com',
      thread_id: 'thread_mock_001',
    },
    source: 'curated',
  },
  {
    toolkit: 'slack',
    slug: 'SLACK_CHANNEL_MESSAGE_RECEIVED',
    name: 'Channel Message Received',
    delivery: 'webhook',
    category: 'communication',
    description:
      'Co tin nhan moi trong mot channel Slack. Dung de tra loi tu dong, chuyen tin nhan quan trong sang task, hoac tom tat channel moi sang.',
    fields: [
      f('channel_id', 'string', true, 'Id channel chua tin nhan.'),
      f('channel_name', 'string', false, 'Ten channel (neu co).'),
      f('user_id', 'string', true, 'Id user gui tin nhan.'),
      f('text', 'string', true, 'Noi dung tin nhan.'),
      f('message_ts', 'string', true, 'Timestamp cua tin nhan (dinh danh duy nhat).'),
    ],
    examplePayload: {
      channel_id: 'C_mock_001',
      channel_name: 'mock-general',
      user_id: 'U_mock_001',
      text: 'Mock: moi nguoi xem bao cao thang 11 nhe',
      message_ts: '1763000000.000100',
    },
    source: 'curated',
  },
  {
    toolkit: 'slack',
    slug: 'SLACK_DIRECT_MESSAGE_RECEIVED',
    name: 'Direct Message Received',
    delivery: 'webhook',
    category: 'communication',
    description:
      'Co tin nhan truc tiep (DM) moi gui cho user da ket noi. Dung de tra loi DM tu dong hoac bao user khi sep/khach hang nhan rieng.',
    fields: [
      f('user_id', 'string', true, 'Id user gui DM.'),
      f('text', 'string', true, 'Noi dung tin nhan.'),
      f('message_ts', 'string', true, 'Timestamp cua tin nhan.'),
      f('channel_id', 'string', false, 'Id channel DM.'),
    ],
    examplePayload: {
      user_id: 'U_mock_002',
      text: 'Mock: ban ranh hop 15h khong?',
      message_ts: '1763000100.000200',
      channel_id: 'D_mock_001',
    },
    source: 'curated',
  },
  {
    toolkit: 'discord',
    slug: 'DISCORD_NEW_MESSAGE_TRIGGER',
    name: 'New Discord Message Trigger',
    delivery: 'poll',
    category: 'communication',
    description:
      'Co tin nhan moi trong mot server/kenh Discord dang theo doi. Dung de tra loi cong dong, ghi log cau hoi thuong gap, hoac bao khi co tu khoa quan trong.',
    fields: [
      f('message_id', 'string', true, 'Id duy nhat cua tin nhan.'),
      f('channel_id', 'string', true, 'Id kenh chua tin nhan.'),
      f('author', 'string', true, 'Ten user gui tin nhan.'),
      f('content', 'string', true, 'Noi dung tin nhan.'),
    ],
    examplePayload: {
      message_id: 'msg_mock_discord_001',
      channel_id: 'ch_mock_001',
      author: 'mock-user',
      content: 'Mock: ai biet cach cai dat bot khong?',
    },
    source: 'curated',
  },
  {
    toolkit: 'outlook',
    slug: 'OUTLOOK_MESSAGE_TRIGGER',
    name: 'New Outlook Message',
    delivery: 'poll',
    category: 'communication',
    description:
      'Co email moi trong Outlook. Dung cho user dung Outlook lam hop thu chinh: tom tat, tao task, hoac chuyen tiep email quan trong.',
    fields: [
      f('message_id', 'string', true, 'Id duy nhat cua email trong Outlook.'),
      f('subject', 'string', true, 'Tieu de email.'),
      f('sender', 'string', true, 'Dia chi email nguoi gui.'),
      f('received_at', 'string', false, 'Thoi diem nhan email (ISO 8601).'),
    ],
    examplePayload: {
      message_id: 'msg_mock_outlook_001',
      subject: 'Mock: lich hop tuan sau',
      sender: 'mock-colleague@example.com',
      received_at: '2026-11-16T02:00:00Z',
    },
    source: 'curated',
  },
  // --- Code: GitHub -------------------------------------------------------
  {
    toolkit: 'github',
    slug: 'GITHUB_COMMIT_EVENT',
    name: 'Commit Event',
    delivery: 'webhook',
    category: 'code',
    description:
      'Co commit moi duoc push len repo. Dung de chay review tu dong, bao team khi co commit vao main, hoac ghi changelog tu commit message.',
    fields: [
      f('commit_sha', 'string', true, 'SHA cua commit.'),
      f('message', 'string', true, 'Commit message.'),
      f('author', 'string', true, 'Ten tac gia commit.'),
      f('repository', 'string', true, 'Ten repo dang owner/repo.'),
      f('branch', 'string', false, 'Nhanh vua nhan commit.'),
    ],
    examplePayload: {
      commit_sha: 'a1b2c3d4e5f6',
      message: 'Mock: them tinh nang poll v2',
      author: 'mock-dev',
      repository: 'mock-org/mock-repo',
      branch: 'main',
    },
    source: 'curated',
  },
  {
    toolkit: 'github',
    slug: 'GITHUB_ISSUE_CREATED_TRIGGER',
    name: 'New Issue Created',
    delivery: 'poll',
    category: 'code',
    description:
      'Co issue moi duoc tao trong repo. Dung de phan loai issue tu dong (bug/feature), gan nguoi phu trach, hoac bao team khi issue co nhan khan.',
    fields: [
      f('issue_number', 'number', true, 'So thu tu issue trong repo.'),
      f('title', 'string', true, 'Tieu de issue.'),
      f('body', 'string', false, 'Noi dung mo ta issue.'),
      f('author', 'string', true, 'Nguoi tao issue.'),
      f('labels', 'array', false, 'Nhan gan cho issue.'),
    ],
    examplePayload: {
      issue_number: 42,
      title: 'Mock: loi dang nhap khi het han token',
      body: 'Mock: user bi vang ra khi token het han...',
      author: 'mock-reporter',
      labels: ['bug'],
    },
    source: 'curated',
  },
  {
    toolkit: 'github',
    slug: 'GITHUB_PULL_REQUEST_EVENT',
    name: 'Pull Request Event',
    delivery: 'webhook',
    category: 'code',
    description:
      'Co su kien pull request (mo moi, cap nhat, review, merge). Dung de chay CI check, nho reviewer, tóm tắt diff cho reviewer, hoac bao khi PR duoc merge.',
    fields: [
      f('pull_number', 'number', true, 'So thu tu pull request.'),
      f('action', 'string', true, 'Hanh dong: opened, synchronize, closed...'),
      f('title', 'string', true, 'Tieu de pull request.'),
      f('author', 'string', true, 'Nguoi tao pull request.'),
      f('merged', 'boolean', false, 'true neu PR vua duoc merge.'),
    ],
    examplePayload: {
      pull_number: 7,
      action: 'opened',
      title: 'Mock: them Composio polling v2',
      author: 'mock-dev',
      merged: false,
    },
    source: 'curated',
  },
  // --- Project: Jira / Linear / Trello / Asana / Monday / ClickUp --------
  {
    toolkit: 'jira',
    slug: 'JIRA_ISSUE_CREATED',
    name: 'Issue Created',
    delivery: 'webhook',
    category: 'project',
    description:
      'Co issue Jira moi duoc tao. Dung de dong bo issue sang board khac, bao Slack khi issue muc do cao duoc tao, hoac gan nguoi phu trach theo project.',
    fields: [
      f('issue_key', 'string', true, 'Key issue, vd MOCK-123.'),
      f('summary', 'string', true, 'Tom tat issue.'),
      f('project_key', 'string', true, 'Key project chua issue.'),
      f('priority', 'string', false, 'Muc do uu tien (Highest/High/Medium/Low).'),
      f('reporter', 'string', false, 'Nguoi bao cao issue.'),
    ],
    examplePayload: {
      issue_key: 'MOCK-123',
      summary: 'Mock: loi xuat hoa don',
      project_key: 'MOCK',
      priority: 'High',
      reporter: 'mock-pm',
    },
    source: 'curated',
  },
  {
    toolkit: 'jira',
    slug: 'JIRA_ISSUE_UPDATED',
    name: 'Issue Updated',
    delivery: 'webhook',
    category: 'project',
    description:
      'Mot issue Jira vua bi thay doi (trang thai, nguoi phu trach, uu tien...). Dung de bao khi issue chuyen sang Done hoac bi doi uu tien len khan.',
    fields: [
      f('issue_key', 'string', true, 'Key issue, vd MOCK-123.'),
      f('status', 'string', true, 'Trang thai moi cua issue.'),
      f('assignee', 'string', false, 'Nguoi phu trach moi (neu doi).'),
      f('changed_by', 'string', false, 'Nguoi vua thay doi issue.'),
    ],
    examplePayload: {
      issue_key: 'MOCK-123',
      status: 'In Progress',
      assignee: 'mock-dev',
      changed_by: 'mock-pm',
    },
    source: 'curated',
  },
  {
    toolkit: 'linear',
    slug: 'LINEAR_ISSUE_CREATED_TRIGGER',
    name: 'Issue Created Trigger',
    delivery: 'webhook',
    category: 'project',
    description:
      'Co issue Linear moi. Dung de dong bo voi GitHub/Jira, bao team khi issue duoc tao trong cycle hien tai, hoac uoc luong do phuc tap tu dong.',
    fields: [
      f('issue_id', 'string', true, 'Id duy nhat cua issue Linear.'),
      f('identifier', 'string', true, 'Ma issue, vd MOCK-45.'),
      f('title', 'string', true, 'Tieu de issue.'),
      f('team', 'string', false, 'Ten team so huu issue.'),
      f('priority', 'number', false, 'Muc do uu tien 0-4 (0 = khong uu tien).'),
    ],
    examplePayload: {
      issue_id: 'iss_mock_001',
      identifier: 'MOCK-45',
      title: 'Mock: cai thien toc do poll',
      team: 'mock-team',
      priority: 2,
    },
    source: 'curated',
  },
  {
    toolkit: 'trello',
    slug: 'TRELLO_CARD_CREATED',
    name: 'Card Created',
    delivery: 'webhook',
    category: 'project',
    description:
      'Co card Trello moi duoc tao. Dung de gan member/checklist mac dinh theo list, bao khi card xuat hien o list "Can lam ngay", hoac dong bo sang Asana.',
    fields: [
      f('card_id', 'string', true, 'Id duy nhat cua card.'),
      f('name', 'string', true, 'Ten card.'),
      f('list_id', 'string', true, 'Id list chua card.'),
      f('board_id', 'string', true, 'Id board chua card.'),
    ],
    examplePayload: {
      card_id: 'card_mock_001',
      name: 'Mock: viet docs polling v2',
      list_id: 'list_mock_001',
      board_id: 'board_mock_001',
    },
    source: 'curated',
  },
  {
    toolkit: 'asana',
    slug: 'ASANA_TASK_CREATED',
    name: 'New Task Created',
    delivery: 'webhook',
    category: 'project',
    description:
      'Co task Asana moi. Dung de gan nguoi phu trach theo project, dat han mac dinh, hoac bao Slack khi task khan duoc tao.',
    fields: [
      f('task_id', 'string', true, 'Id duy nhat cua task.'),
      f('name', 'string', true, 'Ten task.'),
      f('project_id', 'string', false, 'Id project chua task.'),
      f('due_on', 'string', false, 'Han hoan thanh (YYYY-MM-DD).'),
    ],
    examplePayload: {
      task_id: 'task_mock_001',
      name: 'Mock: review thiet ke moi',
      project_id: 'proj_mock_001',
      due_on: '2026-11-20',
    },
    source: 'curated',
  },
  {
    toolkit: 'monday',
    slug: 'MONDAY_ITEM_CREATED',
    name: 'Item Created',
    delivery: 'webhook',
    category: 'project',
    description:
      'Co item moi tren mot board Monday. Dung de dien gia tri cot mac dinh, bao nguoi phu trach, hoac dong bo item sang Google Sheets.',
    fields: [
      f('item_id', 'string', true, 'Id duy nhat cua item.'),
      f('name', 'string', true, 'Ten item.'),
      f('board_id', 'string', true, 'Id board chua item.'),
      f('group_id', 'string', false, 'Id group chua item.'),
    ],
    examplePayload: {
      item_id: 'item_mock_001',
      name: 'Mock: khach hang moi thang 11',
      board_id: 'board_mock_002',
      group_id: 'group_mock_001',
    },
    source: 'curated',
  },
  {
    toolkit: 'clickup',
    slug: 'CLICKUP_TASK_CREATED',
    name: 'Task Created',
    delivery: 'webhook',
    category: 'project',
    description:
      'Co task ClickUp moi. Dung de gan nguoi phu trach, dat do uu tien theo list, hoac bao khi task duoc tao trong folder du an quan trong.',
    fields: [
      f('task_id', 'string', true, 'Id duy nhat cua task.'),
      f('name', 'string', true, 'Ten task.'),
      f('list_id', 'string', true, 'Id list chua task.'),
      f('status', 'string', false, 'Trang thai ban dau cua task.'),
    ],
    examplePayload: {
      task_id: 'task_mock_cu_001',
      name: 'Mock: chuan bi demo',
      list_id: 'list_mock_cu_001',
      status: 'to do',
    },
    source: 'curated',
  },
  // --- Calendar / Document -------------------------------------------------
  {
    toolkit: 'googlecalendar',
    slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER',
    name: 'Event Created',
    delivery: 'poll',
    category: 'calendar',
    description:
      'Co su kien lich moi duoc tao. Dung de chuan bi tai lieu truoc hop, bao nguoi tham du, hoac chan lich trung voi viec khac.',
    fields: [
      f('event_id', 'string', true, 'Id duy nhat cua su kien.'),
      f('summary', 'string', true, 'Tieu de su kien.'),
      f('start', 'string', true, 'Thoi gian bat dau (ISO 8601).'),
      f('end', 'string', false, 'Thoi gian ket thuc (ISO 8601).'),
      f('attendees', 'array', false, 'Danh sach email nguoi tham du.'),
    ],
    examplePayload: {
      event_id: 'evt_mock_001',
      summary: 'Mock: hop tuan doi T4',
      start: '2026-11-17T09:00:00+07:00',
      end: '2026-11-17T10:00:00+07:00',
      attendees: ['mock-a@example.com'],
    },
    source: 'curated',
  },
  {
    toolkit: 'googlecalendar',
    slug: 'GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER',
    name: 'Event Starting Soon',
    delivery: 'poll',
    category: 'calendar',
    description:
      'Mot su kien sap bat dau. Dung de nhac user chuan bi, gui link hop, hoac tóm tắt noi dung can ban truoc khi hop dien ra.',
    fields: [
      f('event_id', 'string', true, 'Id duy nhat cua su kien.'),
      f('summary', 'string', true, 'Tieu de su kien.'),
      f('start', 'string', true, 'Thoi gian bat dau (ISO 8601).'),
      f('minutes_before', 'number', false, 'So phut truoc gio hop ma trigger chay.'),
    ],
    examplePayload: {
      event_id: 'evt_mock_002',
      summary: 'Mock: demo cho khach hang',
      start: '2026-11-17T14:00:00+07:00',
      minutes_before: 15,
    },
    source: 'curated',
  },
  {
    toolkit: 'calendly',
    slug: 'CALENDLY_MEETING_SCHEDULED',
    name: 'Meeting Scheduled',
    delivery: 'webhook',
    category: 'calendar',
    description:
      'Co nguoi dat lich hop qua Calendly. Dung de gui email xac nhan, tao su kien lich, hoac chuan bi ho so khach hang truoc gio hen.',
    fields: [
      f('event_id', 'string', true, 'Id duy nhat cua lich hen.'),
      f('invitee_name', 'string', true, 'Ten nguoi dat lich.'),
      f('invitee_email', 'string', true, 'Email nguoi dat lich.'),
      f('start_time', 'string', true, 'Thoi gian bat dau (ISO 8601).'),
    ],
    examplePayload: {
      event_id: 'evt_mock_cal_001',
      invitee_name: 'Mock Client',
      invitee_email: 'mock-client@example.com',
      start_time: '2026-11-18T10:00:00+07:00',
    },
    source: 'curated',
  },
  {
    toolkit: 'notion',
    slug: 'NOTION_PAGE_CREATED',
    name: 'Page Created',
    delivery: 'webhook',
    category: 'document',
    description:
      'Co page Notion moi duoc tao. Dung de gan template mac dinh, bao team khi co tai lieu moi, hoac dua page vao danh muc theo doi.',
    fields: [
      f('page_id', 'string', true, 'Id duy nhat cua page.'),
      f('title', 'string', true, 'Tieu de page.'),
      f('parent_id', 'string', false, 'Id page/database cha.'),
      f('created_by', 'string', false, 'Nguoi tao page.'),
    ],
    examplePayload: {
      page_id: 'page_mock_001',
      title: 'Mock: ke hoach quy 4',
      parent_id: 'db_mock_001',
      created_by: 'mock-user',
    },
    source: 'curated',
  },
  {
    toolkit: 'googledrive',
    slug: 'GOOGLEDRIVE_FILE_CREATED_TRIGGER',
    name: 'File Created',
    delivery: 'poll',
    category: 'document',
    description:
      'Co file moi duoc tao/upload len Google Drive. Dung de phan loai file tu dong, bao khi co hop dong moi, hoac chuyen file vao thu muc luu tru.',
    fields: [
      f('file_id', 'string', true, 'Id duy nhat cua file.'),
      f('name', 'string', true, 'Ten file.'),
      f('mime_type', 'string', false, 'Loai file (vd application/pdf).'),
      f('folder_id', 'string', false, 'Id thu muc chua file.'),
    ],
    examplePayload: {
      file_id: 'file_mock_001',
      name: 'Mock-hop-dong.pdf',
      mime_type: 'application/pdf',
      folder_id: 'folder_mock_001',
    },
    source: 'curated',
  },
  {
    toolkit: 'googlesheets',
    slug: 'GOOGLESHEETS_NEW_ROWS_TRIGGER',
    name: 'New Rows in Google Sheet',
    delivery: 'poll',
    category: 'document',
    description:
      'Co hang moi duoc them vao Google Sheet. Dung de xu ly don dang ky, dong bo hang moi sang CRM, hoac bao khi co don hang moi trong sheet ban hang.',
    fields: [
      f('spreadsheet_id', 'string', true, 'Id duy nhat cua spreadsheet.'),
      f('sheet_name', 'string', true, 'Ten sheet chua hang moi.'),
      f('row_number', 'number', true, 'So thu tu hang moi.'),
      f('values', 'array', true, 'Gia tri cac o trong hang moi.'),
    ],
    examplePayload: {
      spreadsheet_id: 'sheet_mock_001',
      sheet_name: 'Don hang',
      row_number: 12,
      values: ['Mock Customer', 'mock-product', '2'],
    },
    source: 'curated',
  },
  // --- Sales / Billing / Marketing ----------------------------------------
  {
    toolkit: 'stripe',
    slug: 'STRIPE_CHARGE_SUCCEEDED',
    name: 'Charge Succeeded',
    delivery: 'webhook',
    category: 'billing',
    description:
      'Mot khoan thu Stripe vua thanh cong. Dung de gui email cam on, cap nhat don hang sang "da thanh toan", hoac ghi doanh thu vao bao cao.',
    fields: [
      f('charge_id', 'string', true, 'Id duy nhat cua charge.'),
      f('amount', 'number', true, 'So tien (don vi nho nhat cua tien te, vd cent).'),
      f('currency', 'string', true, 'Ma tien te (vd usd).'),
      f('customer_id', 'string', false, 'Id khach hang Stripe.'),
    ],
    examplePayload: { charge_id: 'ch_mock_001', amount: 4900, currency: 'usd', customer_id: 'cus_mock_001' },
    source: 'curated',
  },
  {
    toolkit: 'stripe',
    slug: 'STRIPE_CHARGE_FAILED',
    name: 'Charge Failed',
    delivery: 'webhook',
    category: 'billing',
    description:
      'Mot khoan thu Stripe vua that bai. Dung de bao ngay cho team, gui email nhac khach cap nhat the, hoac tao ticket ho tro khi the bi tu choi.',
    fields: [
      f('charge_id', 'string', true, 'Id duy nhat cua charge that bai.'),
      f('amount', 'number', true, 'So tien (don vi nho nhat cua tien te).'),
      f('currency', 'string', true, 'Ma tien te.'),
      f('failure_message', 'string', false, 'Ly do that bai tra ve tu ngan hang.'),
    ],
    examplePayload: {
      charge_id: 'ch_mock_002',
      amount: 4900,
      currency: 'usd',
      failure_message: 'Mock: the bi tu choi (insufficient funds)',
    },
    source: 'curated',
  },
  {
    toolkit: 'shopify',
    slug: 'SHOPIFY_PRODUCT_CREATED',
    name: 'Product Created',
    delivery: 'webhook',
    category: 'sales',
    description:
      'Co san pham moi duoc tao trong Shopify. Dung de dong bo san pham sang kenh ban khac, bao team marketing chuan bi bai dang, hoac kiem tra gia/mo ta day du chua.',
    fields: [
      f('product_id', 'string', true, 'Id duy nhat cua san pham.'),
      f('title', 'string', true, 'Ten san pham.'),
      f('price', 'string', false, 'Gia ban (dang chuoi).'),
      f('vendor', 'string', false, 'Nha cung cap san pham.'),
    ],
    examplePayload: {
      product_id: 'prod_mock_001',
      title: 'Mock: ao thun open-bot',
      price: '19.99',
      vendor: 'Mock Store',
    },
    source: 'curated',
  },
  {
    toolkit: 'hubspot',
    slug: 'HUBSPOT_CONTACT_CREATED_TRIGGER',
    name: 'Contact Created',
    delivery: 'poll',
    category: 'sales',
    description:
      'Co contact moi trong HubSpot. Dung de gui email chao mung, gan contact cho sales phu trach theo vung, hoac dong bo sang danh sach email marketing.',
    fields: [
      f('contact_id', 'string', true, 'Id duy nhat cua contact.'),
      f('email', 'string', true, 'Email contact.'),
      f('first_name', 'string', false, 'Ten contact.'),
      f('company', 'string', false, 'Cong ty cua contact.'),
    ],
    examplePayload: {
      contact_id: 'ct_mock_001',
      email: 'mock-lead@example.com',
      first_name: 'Mock',
      company: 'Mock Co',
    },
    source: 'curated',
  },
  {
    toolkit: 'zoom',
    slug: 'ZOOM_NEW_CLOUD_RECORDING_TRIGGER',
    name: 'New Cloud Recording',
    delivery: 'poll',
    category: 'communication',
    description:
      'Co ban ghi Zoom moi tren cloud. Dung de tai ban ghi ve luu tru, tao ban ghi chu tu dong tu ban ghi, hoac gui link ghi hinh cho nguoi vang mat.',
    fields: [
      f('recording_id', 'string', true, 'Id duy nhat cua ban ghi.'),
      f('meeting_id', 'string', true, 'Id cuoc hop.'),
      f('topic', 'string', true, 'Chu de cuoc hop.'),
      f('duration_minutes', 'number', false, 'Thoi luong ban ghi (phut).'),
    ],
    examplePayload: {
      recording_id: 'rec_mock_001',
      meeting_id: 'mtg_mock_001',
      topic: 'Mock: hop ra mat san pham',
      duration_minutes: 45,
    },
    source: 'curated',
  },
  {
    toolkit: 'mailchimp',
    slug: 'MAILCHIMP_SUBSCRIBE_TRIGGER',
    name: 'New Subscriber',
    delivery: 'poll',
    category: 'marketing',
    description:
      'Co nguoi moi dang ky danh sach email Mailchimp. Dung de gui email chao mung, gan tag theo nguon dang ky, hoac bao team khi co nguoi dang ky tu chien dich moi.',
    fields: [
      f('email', 'string', true, 'Email nguoi vua dang ky.'),
      f('list_id', 'string', true, 'Id danh sach email.'),
      f('status', 'string', true, 'Trang thai dang ky (subscribed).'),
    ],
    examplePayload: { email: 'mock-sub@example.com', list_id: 'list_mock_001', status: 'subscribed' },
    source: 'curated',
  },
  {
    toolkit: 'typeform',
    slug: 'TYPEFORM_NEW_RESPONSE',
    name: 'New Typeform Response',
    delivery: 'webhook',
    category: 'marketing',
    description:
      'Co nguoi vua gui form Typeform. Dung de dua cau tra loi vao CRM, bao team khi co phan hoi tieu cuc, hoac gui email cam on nguoi dien form.',
    fields: [
      f('response_id', 'string', true, 'Id duy nhat cua cau tra loi.'),
      f('form_id', 'string', true, 'Id form.'),
      f('answers', 'array', true, 'Danh sach cau tra loi (moi muc co field + value).'),
      f('submitted_at', 'string', false, 'Thoi diem gui form (ISO 8601).'),
    ],
    examplePayload: {
      response_id: 'resp_mock_001',
      form_id: 'form_mock_001',
      answers: [{ field: 'mock-rating', value: 5 }],
      submitted_at: '2026-11-16T02:00:00Z',
    },
    source: 'curated',
  },
  // --- Candidate: 6 toolkit mock v114 (slug ung vien, chua live) ---------
  {
    toolkit: 'webflow',
    slug: 'WEBFLOW_FORM_SUBMITTED_TRIGGER',
    name: 'Webflow Form Submitted (candidate)',
    delivery: 'webhook',
    category: 'marketing',
    description:
      '[CANDIDATE] Co nguoi gui form tren site Webflow. Slug ung vien — chua doi chieu live. Dung de dua lead vao CRM hoac gui email xac nhan khi form duoc gui.',
    fields: [
      f('site_id', 'string', true, 'Id site Webflow.'),
      f('form_name', 'string', true, 'Ten form duoc gui.'),
      f('fields', 'object', true, 'Cac field trong form (ten field -> gia tri).'),
      f('submitted_at', 'string', false, 'Thoi diem gui form (ISO 8601).'),
    ],
    examplePayload: {
      site_id: 'site_mock_001',
      form_name: 'Mock: lien he',
      fields: { name: 'Mock Lead', email: 'mock-lead@example.com' },
      submitted_at: '2026-11-16T02:00:00Z',
    },
    source: 'candidate',
  },
  {
    toolkit: 'pipedrive',
    slug: 'PIPEDRIVE_DEAL_STAGE_CHANGED_TRIGGER',
    name: 'Pipedrive Deal Stage Changed (candidate)',
    delivery: 'webhook',
    category: 'sales',
    description:
      '[CANDIDATE] Mot deal Pipedrive vua doi giai doan. Slug ung vien — chua doi chieu live. Dung de bao khi deal vao giai doan "da thang" hoac bi mat.',
    fields: [
      f('deal_id', 'string', true, 'Id duy nhat cua deal.'),
      f('title', 'string', true, 'Ten deal.'),
      f('stage_from', 'string', true, 'Giai doan truoc.'),
      f('stage_to', 'string', true, 'Giai doan moi.'),
      f('value', 'number', false, 'Gia tri deal.'),
    ],
    examplePayload: {
      deal_id: 'deal_mock_001',
      title: 'Mock: hop dong thang 11',
      stage_from: 'proposal',
      stage_to: 'won',
      value: 5000,
    },
    source: 'candidate',
  },
  {
    toolkit: 'chargebee',
    slug: 'CHARGEBEE_SUBSCRIPTION_CREATED_TRIGGER',
    name: 'Chargebee Subscription Created (candidate)',
    delivery: 'webhook',
    category: 'billing',
    description:
      '[CANDIDATE] Co subscription Chargebee moi duoc tao. Slug ung vien — chua doi chieu live. Dung de gui email chao mung goi moi hoac cap quyen truy cap san pham.',
    fields: [
      f('subscription_id', 'string', true, 'Id duy nhat cua subscription.'),
      f('customer_id', 'string', true, 'Id khach hang.'),
      f('plan_id', 'string', true, 'Id goi dich vu.'),
      f('status', 'string', true, 'Trang thai subscription (active/trialing...).'),
    ],
    examplePayload: {
      subscription_id: 'sub_mock_001',
      customer_id: 'cus_mock_002',
      plan_id: 'plan_mock_pro',
      status: 'active',
    },
    source: 'candidate',
  },
  {
    toolkit: 'xero',
    slug: 'XERO_INVOICE_CREATED_TRIGGER',
    name: 'Xero Invoice Created (candidate)',
    delivery: 'poll',
    category: 'billing',
    description:
      '[CANDIDATE] Co hoa don Xero moi duoc tao. Slug ung vien — chua doi chieu live. Dung de gui hoa don cho khach, bao ke toan, hoac doi chieu cong no.',
    fields: [
      f('invoice_id', 'string', true, 'Id duy nhat cua hoa don.'),
      f('invoice_number', 'string', true, 'So hoa don.'),
      f('contact_name', 'string', true, 'Ten khach hang tren hoa don.'),
      f('total', 'number', true, 'Tong tien hoa don.'),
      f('status', 'string', false, 'Trang thai hoa don (DRAFT/AUTHORISED/PAID...).'),
    ],
    examplePayload: {
      invoice_id: 'inv_mock_001',
      invoice_number: 'INV-0001',
      contact_name: 'Mock Client',
      total: 1200,
      status: 'AUTHORISED',
    },
    source: 'candidate',
  },
  {
    toolkit: 'eventbrite',
    slug: 'EVENTBRITE_ORDER_PLACED_TRIGGER',
    name: 'Eventbrite Order Placed (candidate)',
    delivery: 'webhook',
    category: 'sales',
    description:
      '[CANDIDATE] Co don dat ve Eventbrite moi. Slug ung vien — chua doi chieu live. Dung de gui ve dien tu, cap nhat so luong ve con lai, hoac bao khi su kien sap het ve.',
    fields: [
      f('order_id', 'string', true, 'Id duy nhat cua don dat ve.'),
      f('event_id', 'string', true, 'Id su kien.'),
      f('buyer_email', 'string', true, 'Email nguoi mua ve.'),
      f('quantity', 'number', true, 'So ve da dat.'),
      f('total', 'number', false, 'Tong tien don.'),
    ],
    examplePayload: {
      order_id: 'ord_mock_001',
      event_id: 'ev_mock_001',
      buyer_email: 'mock-buyer@example.com',
      quantity: 2,
      total: 4000,
    },
    source: 'candidate',
  },
  {
    toolkit: 'surveymonkey',
    slug: 'SURVEYMONKEY_RESPONSE_COMPLETED_TRIGGER',
    name: 'SurveyMonkey Response Completed (candidate)',
    delivery: 'poll',
    category: 'marketing',
    description:
      '[CANDIDATE] Co nguoi vua hoan thanh khao sat SurveyMonkey. Slug ung vien — chua doi chieu live. Dung de phan tich phan hoi, bao khi co danh gia thap, hoac dua ket qua vao bao cao.',
    fields: [
      f('response_id', 'string', true, 'Id duy nhat cua cau tra loi.'),
      f('survey_id', 'string', true, 'Id khao sat.'),
      f('is_complete', 'boolean', true, 'true khi khao sat da dien day du.'),
      f('submitted_at', 'string', false, 'Thoi diem hoan thanh (ISO 8601).'),
    ],
    examplePayload: {
      response_id: 'resp_mock_002',
      survey_id: 'sur_mock_001',
      is_complete: true,
      submitted_at: '2026-11-16T02:00:00Z',
    },
    source: 'candidate',
  },
];

/** Tong so template v114 (30: 24 curated + 6 candidate). */
export const COMPOSIO_V114_TRIGGER_TEMPLATE_COUNT = COMPOSIO_V114_TRIGGER_TEMPLATES.length;

/** Tim template theo slug trigger (undefined neu khong co). */
export function findComposioV114TriggerTemplate(slug: string): ComposioV114TriggerTemplate | undefined {
  return COMPOSIO_V114_TRIGGER_TEMPLATES.find((t) => t.slug === slug);
}

/** Tat ca template cua mot toolkit. */
export function composioV114TemplatesForToolkit(toolkit: string): ComposioV114TriggerTemplate[] {
  return COMPOSIO_V114_TRIGGER_TEMPLATES.filter((t) => t.toolkit === toolkit);
}

/** Tat ca template cua mot nhom cong viec. */
export function composioV114TemplatesForCategory(
  category: ComposioV114TriggerCategory,
): ComposioV114TriggerTemplate[] {
  return COMPOSIO_V114_TRIGGER_TEMPLATES.filter((t) => t.category === category);
}

/** Tim template theo tu khoa (trong slug/name/description — khong phan biet hoa thuong). */
export function searchComposioV114TriggerTemplates(query: string): ComposioV114TriggerTemplate[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...COMPOSIO_V114_TRIGGER_TEMPLATES];
  return COMPOSIO_V114_TRIGGER_TEMPLATES.filter((t) =>
    `${t.slug} ${t.name} ${t.description} ${t.toolkit}`.toLowerCase().includes(q),
  );
}

/**
 * Kiem tra template co hop le khong (throw neu sai):
 * - slug dung dinh dang trigger Composio;
 * - template curated PHAI co trong COMPOSIO_TRIGGER_DEFS (slug da xac nhan);
 * - template candidate KHONG duoc trung slug curated (de khong nham lan);
 * - moi field trong `fields` phai co trong `examplePayload` khi required;
 * - khong trung slug giua cac template.
 */
export function validateComposioV114TriggerTemplates(
  templates: readonly ComposioV114TriggerTemplate[] = COMPOSIO_V114_TRIGGER_TEMPLATES,
): void {
  const seenSlugs = new Set<string>();
  const curatedSlugs = new Set(COMPOSIO_TRIGGER_DEFS.map((d) => d.slug));
  for (const t of templates) {
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(t.slug)) {
      throw new Error(`template slug must match ^[A-Z][A-Z0-9_]{2,}$ (got ${t.slug})`);
    }
    if (seenSlugs.has(t.slug)) throw new Error(`duplicate trigger template slug: ${t.slug}`);
    seenSlugs.add(t.slug);
    if (typeof t.toolkit !== 'string' || t.toolkit.trim() === '') {
      throw new Error(`template ${t.slug} must have a non-empty toolkit`);
    }
    if (typeof t.description !== 'string' || t.description.trim() === '') {
      throw new Error(`template ${t.slug} must have a non-empty description`);
    }
    if (!Array.isArray(t.fields) || t.fields.length === 0) {
      throw new Error(`template ${t.slug} must declare at least one field`);
    }
    const fieldNames = new Set<string>();
    for (const field of t.fields) {
      if (fieldNames.has(field.name)) throw new Error(`template ${t.slug} has duplicate field: ${field.name}`);
      fieldNames.add(field.name);
      if (field.required && !(field.name in t.examplePayload)) {
        throw new Error(`template ${t.slug}: required field ${field.name} missing from examplePayload`);
      }
    }
    if (t.source === 'curated' && !curatedSlugs.has(t.slug)) {
      throw new Error(`curated template ${t.slug} is not in COMPOSIO_TRIGGER_DEFS — verify the slug live first`);
    }
    if (t.source === 'candidate' && curatedSlugs.has(t.slug)) {
      throw new Error(`candidate template ${t.slug} collides with a curated slug — mark it curated`);
    }
  }
}

/**
 * Render vi du payload thanh chuoi JSON de hien trong UI (2 space,
 * khong chua secret — payload chi la du lieu mau).
 */
export function renderComposioV114ExamplePayload(template: ComposioV114TriggerTemplate): string {
  return JSON.stringify(template.examplePayload, null, 2);
}

/**
 * Chuyen template thanh input cho triggerMapping (automation):
 * tra ve slug + danh sach field bat buoc de automation biet
 * field nao chac chan co trong event.
 */
export function composioV114TemplateToMappingInput(template: ComposioV114TriggerTemplate): {
  triggerSlug: string;
  toolkit: string;
  requiredFields: string[];
  optionalFields: string[];
} {
  return {
    triggerSlug: template.slug,
    toolkit: template.toolkit,
    requiredFields: template.fields.filter((f) => f.required).map((f) => f.name),
    optionalFields: template.fields.filter((f) => !f.required).map((f) => f.name),
  };
}
