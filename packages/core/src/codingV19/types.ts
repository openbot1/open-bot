/**
 * Coding agent v19 — types (v1.41, Đội T4).
 *
 * Ý tưởng học từ survey v141 §3 (OpenHands SDK v1.60 / Agent Canvas
 * v1.39): Conversation chạy trên event log (event-backed), mỗi
 * conversation có Workspace tách bạch, Agent Plugins khai báo bằng
 * `mcp.json`, prompt/plugin preset theo agent profile, cấu hình plugin
 * thực thi được chỉnh sửa trực tiếp. Thiết kế và code là của open-bot
 * (không copy repo khác, không gọi model thật, không gọi mạng — mọi
 * thứ ở đây là dữ liệu + hàm xác định trên file local; host thay các
 * bước scripted bằng model thật sau này qua cùng interface; nối coding
 * agent v18, không viết lại critic/review skill/dependency map/eval
 * harness của v18, cũng không viết lại trajectory log của v17).
 */

export class CodingV19Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingV19Error';
  }
}

/* ------------------------------------------------------------------ */
/* Sự kiện (event log)                                                 */
/* ------------------------------------------------------------------ */

/** Kind của một event trong event log của conversation. */
export type V19EventKind =
  | 'session_start'
  | 'session_end'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'file_edit'
  | 'checkpoint'
  | 'rollback'
  | 'branch'
  | 'preset_applied'
  | 'plugin_change'
  | 'note';

/** Mọi kind event hợp lệ (dùng để validate + render). */
export const V19_EVENT_KINDS: readonly V19EventKind[] = [
  'session_start',
  'session_end',
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'file_edit',
  'checkpoint',
  'rollback',
  'branch',
  'preset_applied',
  'plugin_change',
  'note',
];

/** Một event trong event log (append-only, hash-chain). */
export interface V19Event {
  /** Id duy nhất của event (ổn định, dùng để fork/branch trỏ tới). */
  id: string;
  /** Conversation sở hữu event. */
  conversationId: string;
  /** Số thứ tự trong log (bắt đầu từ 1, tăng đều, không có lỗ). */
  seq: number;
  kind: V19EventKind;
  /** Thời điểm event xảy ra (ms epoch). */
  at: number;
  /** Ai tạo event: 'user' | 'agent' | 'system' | 'tool:<tên tool>'. */
  actor: string;
  /** Payload theo kind (xem V19EventPayload). */
  payload: V19EventPayload;
  /** Hash của event trước trong log ('' với event đầu tiên). */
  prevHash: string;
  /** Hash của chính event này (hash-chain chống sửa log lén). */
  hash: string;
}

/** Payload của từng kind event. */
export interface V19EventPayload {
  /** Nội dung tin nhắn (user_message / assistant_message / note). */
  text?: string;
  /** Tên tool được gọi (tool_call / tool_result). */
  toolName?: string;
  /** Argument của tool call (tool_call) — JSON object dạng string. */
  toolArgsJson?: string;
  /** Kết quả tool trả về (tool_result) — text rút gọn. */
  result?: string;
  /** Tool call có thành công không (tool_result). */
  ok?: boolean;
  /** Đường dẫn file tương đối trong workspace (file_edit). */
  filePath?: string;
  /** Hành động trên file: create | edit | delete (file_edit). */
  fileAction?: 'create' | 'edit' | 'delete';
  /** Nội dung file sau khi sửa (file_edit, có thể cắt ngắn). */
  fileContent?: string;
  /** Id checkpoint (checkpoint / rollback). */
  checkpointId?: string;
  /** Mô tả checkpoint (checkpoint). */
  checkpointLabel?: string;
  /** Id conversation đích của branch (branch). */
  branchToConversationId?: string;
  /** Seq event mà branch rẽ ra (branch). */
  branchFromSeq?: number;
  /** Id preset vừa áp dụng (preset_applied). */
  presetId?: string;
  /** Id plugin vừa thay đổi (plugin_change). */
  pluginId?: string;
  /** Thay đổi plugin: load | unload | enable | disable | config (plugin_change). */
  pluginChange?: 'load' | 'unload' | 'enable' | 'disable' | 'config';
  /** Lý do kết thúc phiên (session_end). */
  endReason?: string;
  /** Dữ liệu tự do thêm (không dùng cho replay bắt buộc). */
  extra?: Record<string, unknown>;
}

/** Input khi append một event mới (id/seq/hash do log tự sinh). */
export interface V19AppendEventInput {
  kind: V19EventKind;
  actor?: string;
  at?: number;
  payload?: V19EventPayload;
}

/* ------------------------------------------------------------------ */
/* Trạng thái conversation suy ra từ replay                            */
/* ------------------------------------------------------------------ */

/** Một tin nhắn trong conversation (suy ra từ replay). */
export interface V19ReplayMessage {
  seq: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: number;
}

/** Một tool call trong conversation (suy ra từ replay). */
export interface V19ReplayToolCall {
  seq: number;
  toolName: string;
  argsJson: string;
  /** Kết quả (undefined khi tool call chưa có tool_result đi kèm). */
  result?: string;
  ok?: boolean;
  at: number;
}

/** Trạng thái conversation sau khi replay toàn bộ event log. */
export interface V19ConversationState {
  conversationId: string;
  /** true khi log có session_end và chưa có event nào sau đó. */
  ended: boolean;
  endReason?: string;
  /** Tin nhắn user/assistant theo thứ tự. */
  messages: V19ReplayMessage[];
  /** Tool call kèm kết quả (ghép tool_call + tool_result kề nhau). */
  toolCalls: V19ReplayToolCall[];
  /** File đã chạm tới (theo file_edit), kèm action cuối cùng. */
  filesChanged: V19FileChange[];
  /** Checkpoint đã tạo (theo checkpoint event). */
  checkpoints: V19CheckpointRef[];
  /** Preset đang áp dụng (preset_applied gần nhất). */
  presetId?: string;
  /** Plugin đã load/enable (plugin_change gần nhất cho mỗi plugin). */
  plugins: V19PluginRuntimeState[];
  /** Số event đã replay. */
  eventsReplayed: number;
  /** Seq cao nhất đã replay. */
  lastSeq: number;
  /** Thời điểm event đầu / cuối. */
  startedAt: number;
  lastAt: number;
}

/** Một file đã thay đổi trong conversation. */
export interface V19FileChange {
  filePath: string;
  action: 'create' | 'edit' | 'delete';
  /** Seq của file_edit gần nhất chạm file này. */
  lastSeq: number;
  at: number;
}

/** Một checkpoint được ghi nhận trong event log. */
export interface V19CheckpointRef {
  checkpointId: string;
  label: string;
  seq: number;
  at: number;
}

/** Trạng thái runtime của một plugin trong conversation. */
export interface V19PluginRuntimeState {
  pluginId: string;
  loaded: boolean;
  enabled: boolean;
  lastChange: 'load' | 'unload' | 'enable' | 'disable' | 'config';
  lastSeq: number;
}

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

/** Trạng thái lưu của một conversation. */
export type V19ConversationStatus = 'active' | 'ended' | 'archived';

/** Metadata của một conversation (lưu cùng event log). */
export interface V19ConversationMeta {
  id: string;
  title: string;
  /** Agent profile / preset đã áp khi tạo ('' khi không dùng preset). */
  profileId: string;
  /** System prompt đã resolve lúc tạo (snapshot từ preset). */
  systemPrompt: string;
  /** Plugin set đã resolve lúc tạo (snapshot từ preset). */
  pluginIds: string[];
  /** Tool allowlist đã resolve lúc tạo (snapshot từ preset). */
  toolAllowlist: string[];
  status: V19ConversationStatus;
  /** Conversation cha ('' khi không phải branch; fork thì là id cha). */
  parentId: string;
  /** Seq event của cha mà branch này rẽ ra (0 khi không phải branch). */
  branchedFromSeq: number;
  createdAt: number;
  updatedAt: number;
}

/** Input tạo conversation mới. */
export interface V19CreateConversationInput {
  title?: string;
  /** Id preset/profile áp khi tạo ('' = không áp preset, dùng mặc định). */
  profileId?: string;
  /** System prompt ghi đè preset (chỉ dùng khi caller tự resolve). */
  systemPrompt?: string;
  pluginIds?: string[];
  toolAllowlist?: string[];
  now?: number;
}

/* ------------------------------------------------------------------ */
/* Workspace tách bạch                                                */
/* ------------------------------------------------------------------ */

/** Một file trong workspace (đường dẫn tương đối + nội dung). */
export interface V19WorkspaceFile {
  /** Đường dẫn tương đối trong workspace (dùng '/' làm separator). */
  relPath: string;
  content: string;
  size: number;
  /** Hash nội dung (để so sánh snapshot/diff). */
  hash: string;
}

/** Kết quả kiểm tra path containment. */
export interface V19PathCheck {
  /** true khi path nằm trong workspace (kể cả chính workspace root). */
  inside: boolean;
  /** Đường dẫn tương đối đã chuẩn hoá ('' khi path là root). */
  relPath: string;
  /** Đường dẫn tuyệt đối đã resolve. */
  absolutePath: string;
  /** Lý do bị chặn ('' khi inside=true). */
  reason: string;
}

/** Một snapshot/checkpoint của workspace. */
export interface V19WorkspaceSnapshot {
  id: string;
  conversationId: string;
  label: string;
  /** Seq event lúc tạo snapshot (để rollback theo event). */
  atSeq: number;
  createdAt: number;
  /** Manifest file: path -> {size, hash}. */
  files: Record<string, V19SnapshotFileEntry>;
}

/** Một entry trong manifest của snapshot. */
export interface V19SnapshotFileEntry {
  size: number;
  hash: string;
}

/** Kết quả rollback workspace về một snapshot. */
export interface V19RollbackResult {
  snapshotId: string;
  conversationId: string;
  restored: string[];
  /** File tạo sau snapshot nên bị xoá khi rollback. */
  deleted: string[];
  atSeq: number;
  at: number;
}

/** Một file thay đổi giữa hai trạng thái workspace (diff viewer data). */
export interface V19WorkspaceDiffEntry {
  relPath: string;
  status: 'added' | 'modified' | 'deleted' | 'unchanged';
  oldLines: number;
  newLines: number;
  /** Số dòng thêm / xoá (đếm bằng diff dòng đơn giản). */
  addedLines: number;
  removedLines: number;
  /** Các hunk diff dạng unified (giới hạn dòng để UI render được). */
  hunks: V19DiffHunk[];
}

/** Một hunk diff (dạng unified, context 3 dòng). */
export interface V19DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: V19DiffLine[];
}

/** Một dòng trong hunk diff. */
export interface V19DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

/* ------------------------------------------------------------------ */
/* Agent Plugins — mcp.json                                            */
/* ------------------------------------------------------------------ */

/** Transport của một MCP server trong plugin. */
export type V19McpTransport = 'stdio' | 'http' | 'sse';

/** Một MCP server khai báo trong plugin manifest (mcp.json). */
export interface V19McpServerDef {
  /** Id duy nhất trong plugin (slug). */
  id: string;
  /** Tên hiển thị. */
  name?: string;
  transport: V19McpTransport;
  /** Lệnh chạy server (bắt buộc với stdio). */
  command?: string;
  /** Argument cho command (stdio). */
  args?: string[];
  /** URL server (bắt buộc với http/sse). */
  url?: string;
  /** Biến môi trường truyền cho server (stdio). */
  env?: Record<string, string>;
  /** Header HTTP (http/sse). */
  headers?: Record<string, string>;
  /** Timeout gọi tool (ms, mặc định 30000). */
  timeoutMs?: number;
  /** Server có bật mặc định khi plugin load không. */
  enabled?: boolean;
}

/** Plugin manifest — nội dung file `mcp.json` của coding agent. */
export interface V19PluginManifest {
  /** Id plugin (slug, duy nhất). */
  name: string;
  /** Phiên bản semver-ish (vd '1.2.0'). */
  version: string;
  /** Mô tả ngắn. */
  description?: string;
  /** Tác giả / nhà phát hành. */
  author?: string;
  /** Nhóm: filesystem | git | search | database | browser | testing | other. */
  category?: string;
  /** MCP server mà plugin cung cấp. */
  servers: V19McpServerDef[];
  /** Tool mà plugin cung cấp (tên tool, để allowlist kiểm tra). */
  tools?: string[];
  /** Quyền plugin xin: read | write | exec | network (mặc định read). */
  permissions?: string[];
  /** Config mặc định của plugin (executable config, chỉnh được). */
  config?: Record<string, unknown>;
  /** Config schema rút gọn: key -> {type, required?, default?}. */
  configSchema?: Record<string, V19PluginConfigField>;
}

/** Một field trong config schema của plugin. */
export interface V19PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required?: boolean;
  default?: unknown;
  description?: string;
}

/** Trạng thái cài đặt của một plugin (load/unload/enable). */
export interface V19PluginState {
  manifest: V19PluginManifest;
  loaded: boolean;
  /** Server nào đang enabled (theo id). */
  enabledServers: string[];
  /** Config đang áp dụng (đã validate, có thể khác config mặc định). */
  appliedConfig: Record<string, unknown>;
  /** Số lần config được sửa (version tăng mỗi lần áp thành công). */
  configVersion: number;
  loadedAt?: number;
}

/** Kết quả validate manifest / config. */
export interface V19ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Thay đổi config plugin (editable executable plugin config). */
export interface V19PluginConfigChange {
  pluginName: string;
  /** Config mới toàn bộ (merge lên config hiện tại hay thay hẳn). */
  config: Record<string, unknown>;
  /** true = thay hẳn config; false = merge từng key (mặc định merge). */
  replace?: boolean;
  /** Server nào bật/tắt kèm theo (không đổi khi bỏ trống). */
  enabledServers?: string[];
}

/** Kết quả áp config plugin (đã validate trước khi áp). */
export interface V19PluginConfigApplyResult {
  pluginName: string;
  applied: boolean;
  configVersion: number;
  appliedConfig: Record<string, unknown>;
  enabledServers: string[];
  errors: string[];
}

/** Một mục trong marketplace nội bộ (plugin đã cài + catalog). */
export interface V19MarketplaceEntry {
  name: string;
  version: string;
  description: string;
  category: string;
  /** 'installed' | 'catalog' (catalog = biết tới, chưa cài manifest). */
  source: 'installed' | 'catalog';
  loaded: boolean;
  enabledServers: number;
  totalServers: number;
  tools: string[];
}

/* ------------------------------------------------------------------ */
/* Agent profile presets                                               */
/* ------------------------------------------------------------------ */

/** Một agent profile preset: system prompt + plugin set + allowlist. */
export interface V19AgentPreset {
  /** Id preset (slug, duy nhất). */
  id: string;
  /** Tên hiển thị. */
  name: string;
  /** Mô tả preset dùng cho trường hợp nào. */
  description?: string;
  /** System prompt áp cho conversation dùng preset này. */
  systemPrompt: string;
  /** Plugin (tên manifest) preset này bật. */
  pluginIds: string[];
  /** Tool được phép gọi (tên tool; rỗng = cho phép tất cả tool v19). */
  toolAllowlist: string[];
  /** Số bước agent tối đa (mặc định 50). */
  maxSteps?: number;
  /** true = preset có sẵn của hệ thống (không xoá được). */
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Input tạo/cập nhật preset (id sinh từ name khi tạo mới). */
export interface V19PresetInput {
  id?: string;
  name: string;
  description?: string;
  systemPrompt: string;
  pluginIds?: string[];
  toolAllowlist?: string[];
  maxSteps?: number;
}

/** Kết quả áp preset lên conversation (snapshot đã resolve). */
export interface V19PresetApplyResult {
  presetId: string;
  presetName: string;
  systemPrompt: string;
  pluginIds: string[];
  toolAllowlist: string[];
  maxSteps: number;
  /** Plugin trong preset chưa cài (cảnh báo, không chặn). */
  missingPlugins: string[];
}

/* ------------------------------------------------------------------ */
/* Agent v19 (scripted run)                                            */
/* ------------------------------------------------------------------ */

/** Một bước scripted của agent v19. */
export interface V19AgentStep {
  /** Nội dung bước (tin nhắn / mô tả hành động). */
  text: string;
  /** Ghi file vào workspace (tương đối, chặn traversal). */
  fileWrite?: { path: string; content: string; kind?: 'create' | 'edit'; oldText?: string };
  /** Xoá file khỏi workspace. */
  fileDelete?: string;
  /** Tool call giả lập (ghi vào event log, không gọi model thật). */
  toolCall?: { toolName: string; argsJson?: string; result?: string; ok?: boolean };
  /** true = bước test (đánh dấu trajectory có test). */
  isTest?: boolean;
  /** false = bỏ qua bước này (mặc định chạy). */
  done?: boolean;
}

/** Input chạy agent v19 scripted end-to-end. */
export interface V19RunAgentInput {
  /** Conversation đã có ('' = tạo mới từ profileId). */
  conversationId?: string;
  title?: string;
  /** Preset/profile áp khi tạo conversation mới. */
  profileId?: string;
  task: string;
  steps: V19AgentStep[];
  /** Workspace root của conversation (bắt buộc khi tạo mới). */
  workspaceRoot?: string;
  /** Data dir chứa event log + snapshot (khi cần lưu). */
  dataDir?: string;
  /** Checkpoint cuối phiên không (mặc định true). */
  checkpointAtEnd?: boolean;
  now?: number;
}

/** Báo cáo chạy agent v19. */
export interface V19AgentReport {
  conversationId: string;
  profileId: string;
  task: string;
  stepsRun: number;
  stepsSkipped: number;
  eventsAppended: number;
  lastSeq: number;
  filesChanged: V19FileChange[];
  toolCalls: number;
  checkpointId?: string;
  ended: boolean;
  at: number;
}

/* ------------------------------------------------------------------ */
/* Hằng số                                                             */
/* ------------------------------------------------------------------ */

/** Giới hạn giữ event log / snapshot trong bộ nhớ khi list. */
export const V19_MAX_EVENTS_PER_CONVERSATION = 10000;
/** Số checkpoint tối đa giữ cho một conversation. */
export const V19_MAX_CHECKPOINTS_PER_CONVERSATION = 50;
/** Số plugin tối đa trong một manifest. */
export const V19_MAX_SERVERS_PER_PLUGIN = 32;
/** Số preset tối đa (builtin + custom). */
export const V19_MAX_PRESETS = 100;
/** Kích thước file tối đa ghi qua workspace v19 (10 MiB). */
export const V19_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Số dòng context mỗi bên trong hunk diff. */
export const V19_DIFF_CONTEXT_LINES = 3;
