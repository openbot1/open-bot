/**
 * MCP Apps v2 — gallery + template (v1.14, Đội T2).
 *
 * Host v13 (`appsHostV13.ts`) đã có 4 sample app (dashboard / form /
 * monitor / table) và catalogue v112 đã có danh sách app cài đặt — nhưng
 * chưa có GALLERY template đúng nghĩa: mỗi template có JSON input schema
 * để agent/user biết điền gì, một renderer biến input thành component,
 * và ví dụ mẫu chạy được ngay. Module này là gallery đó, nối trên
 * component kit v1.13 (`appsComponents.ts`) — không render HTML tay:
 *
 *   - 4 template: `dashboard` (metric + chart + table), `form`
 *     (form nhập liệu gọi tool), `chart` (biểu đồ + bảng số liệu),
 *     `wizard` (nhiều bước, mỗi bước một form, có bước hiện tại).
 *   - Mỗi template: `inputSchema` (JSON Schema subset: type /
 *     properties / required / enum / minItems), `exampleInput`,
 *     `renderTemplate(id, input)` -> `AppComponent[]`.
 *   - `validateGalleryInput()` kiểm tra input theo schema trước khi
 *     render — lỗi trả về danh sách rõ ràng thay vì render nửa vời.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import {
  assertValidAppComponent,
  type AppComponent,
  type AppFormField,
} from './appsComponents';

/** Kind template trong gallery. */
export type McpAppGalleryKind = 'dashboard' | 'form' | 'chart' | 'wizard';

/** Các kind template có trong gallery. */
export const MCP_APP_GALLERY_KINDS: readonly McpAppGalleryKind[] = [
  'dashboard',
  'form',
  'chart',
  'wizard',
];

/** JSON Schema subset dùng cho input của template. */
export interface GalleryInputSchema {
  type: 'object';
  properties: Record<string, GalleryInputProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface GalleryInputProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: (string | number)[];
  items?: GalleryInputProperty;
  properties?: Record<string, GalleryInputProperty>;
  required?: string[];
  minItems?: number;
  maxItems?: number;
}

/** Một template trong gallery. */
export interface McpAppGalleryTemplate {
  id: string;
  kind: McpAppGalleryKind;
  /** Tiêu đề hiển thị (i18n key ở UI: `mcpAppsV2.gallery.<id>.title`). */
  title: string;
  description: string;
  /** Schema input template nhận (để agent/user điền đúng). */
  inputSchema: GalleryInputSchema;
  /** Input ví dụ — render được ngay không cần điền. */
  exampleInput: Record<string, unknown>;
  /** Tool mặc định form trong template gọi (khi template có form). */
  defaultTool?: string;
}

export class GalleryTemplateError extends Error {
  readonly templateId?: string;
  constructor(message: string, templateId?: string) {
    super(message);
    this.name = 'GalleryTemplateError';
    if (templateId) this.templateId = templateId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 4 template của gallery. */
export const MCP_APP_GALLERY_TEMPLATES: readonly McpAppGalleryTemplate[] = [
  {
    id: 'dashboard',
    kind: 'dashboard',
    title: 'Dashboard tổng quan',
    description: 'Metric chính + biểu đồ xu hướng + bảng chi tiết mới nhất.',
    defaultTool: 'mcp_apps_v2_gallery_render',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tiêu đề dashboard' },
        metrics: {
          type: 'array',
          description: 'Danh sách metric (label + value)',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              delta: { type: 'string' },
            },
            required: ['label', 'value'],
          },
        },
        chartLabels: { type: 'array', description: 'Nhãn trục X của biểu đồ', items: { type: 'string' } },
        chartValues: { type: 'array', description: 'Giá trị biểu đồ', items: { type: 'number' } },
        tableColumns: { type: 'array', description: 'Cột bảng chi tiết', items: { type: 'string' } },
        tableRows: { type: 'array', description: 'Hàng bảng chi tiết', items: { type: 'array', items: { type: 'string' } } },
      },
      required: ['title', 'metrics'],
    },
    exampleInput: {
      title: 'Tổng quan hôm nay',
      metrics: [
        { label: 'Task hoàn thành', value: '12', delta: '+3' },
        { label: 'Task đang chạy', value: '4', delta: '' },
        { label: 'Lỗi', value: '0', delta: '' },
      ],
      chartLabels: ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'],
      chartValues: [4, 7, 5, 9, 12, 8, 11],
      tableColumns: ['Task', 'Trạng thái', 'Tiến độ'],
      tableRows: [
        ['Đồng bộ Gmail', 'completed', '100%'],
        ['Lập chỉ mục repo', 'running', '62%'],
        ['Sao lưu memory', 'pending', '0%'],
      ],
    },
  },
  {
    id: 'form',
    kind: 'form',
    title: 'Form nhập liệu',
    description: 'Form gọi một tool với các field nhập liệu, có mô tả và nút gửi.',
    defaultTool: 'mcp_apps_v2_gallery_render',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tiêu đề form' },
        description: { type: 'string', description: 'Mô tả ngắn dưới tiêu đề' },
        tool: { type: 'string', description: 'Tool form sẽ gọi khi submit' },
        submitLabel: { type: 'string', description: 'Nhãn nút gửi' },
        fields: {
          type: 'array',
          description: 'Các field của form',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              label: { type: 'string' },
              type: { type: 'string', enum: ['text', 'number', 'select', 'checkbox', 'textarea', 'date'] },
              required: { type: 'boolean' },
              placeholder: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'label', 'type'],
          },
        },
      },
      required: ['title', 'tool', 'fields'],
    },
    exampleInput: {
      title: 'Tạo task mới',
      description: 'Điền thông tin rồi bấm gửi — task sẽ chạy nền và poll kết quả.',
      tool: 'mcp_tasks_v2_poll',
      submitLabel: 'Tạo task',
      fields: [
        { name: 'title', label: 'Tên task', type: 'text', required: true, placeholder: 'vd: Đồng bộ Gmail' },
        { name: 'priority', label: 'Ưu tiên', type: 'select', options: ['low', 'normal', 'high'] },
        { name: 'notes', label: 'Ghi chú', type: 'textarea', placeholder: 'Mô tả thêm (không bắt buộc)' },
      ],
    },
  },
  {
    id: 'chart',
    kind: 'chart',
    title: 'Biểu đồ + bảng số liệu',
    description: 'Biểu đồ đường/cột kèm bảng số liệu gốc để đối chiếu.',
    defaultTool: 'mcp_apps_v2_gallery_render',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tiêu đề biểu đồ' },
        kind: { type: 'string', description: 'Dạng biểu đồ', enum: ['bar', 'line'] },
        labels: { type: 'array', description: 'Nhãn trục X', minItems: 1, items: { type: 'string' } },
        values: { type: 'array', description: 'Giá trị (khớp số lượng labels)', minItems: 1, items: { type: 'number' } },
        unit: { type: 'string', description: 'Đơn vị (vd: ms, task)' },
        tableTitle: { type: 'string', description: 'Tiêu đề bảng số liệu' },
      },
      required: ['title', 'labels', 'values'],
    },
    exampleInput: {
      title: 'Độ trễ poll task (ms)',
      kind: 'line',
      labels: ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00'],
      values: [820, 760, 910, 690, 740, 705],
      unit: 'ms',
      tableTitle: 'Số liệu gốc',
    },
  },
  {
    id: 'wizard',
    kind: 'wizard',
    title: 'Wizard nhiều bước',
    description: 'Luồng nhiều bước: mỗi bước một form, thanh tiến độ, quay lại / tiếp tục.',
    defaultTool: 'mcp_apps_v2_gallery_render',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Tiêu đề wizard' },
        currentStep: { type: 'number', description: 'Bước đang hiển thị (bắt đầu từ 0)' },
        steps: {
          type: 'array',
          description: 'Các bước (mỗi bước: tiêu đề + mô tả + field)',
          minItems: 2,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              tool: { type: 'string' },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    label: { type: 'string' },
                    type: { type: 'string', enum: ['text', 'number', 'select', 'checkbox', 'textarea', 'date'] },
                    required: { type: 'boolean' },
                    options: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['name', 'label', 'type'],
                },
              },
            },
            required: ['title', 'fields'],
          },
        },
      },
      required: ['title', 'steps'],
    },
    exampleInput: {
      title: 'Kết nối MCP server mới',
      currentStep: 0,
      steps: [
        {
          title: 'Bước 1 — Thông tin server',
          description: 'Nhập tên và lệnh chạy server.',
          tool: 'mcp_server_add',
          fields: [
            { name: 'name', label: 'Tên server', type: 'text', required: true },
            { name: 'command', label: 'Lệnh chạy', type: 'text', required: true, placeholder: 'npx -y @modelcontextprotocol/server-...' },
          ],
        },
        {
          title: 'Bước 2 — Quyền truy cập',
          description: 'Chọn quyền server được phép dùng.',
          tool: 'mcp_server_permissions',
          fields: [
            { name: 'network', label: 'Cho phép truy cập mạng', type: 'checkbox' },
            { name: 'scope', label: 'Phạm vi', type: 'select', options: ['read-only', 'read-write'] },
          ],
        },
        {
          title: 'Bước 3 — Kiểm tra kết nối',
          description: 'Chạy server/discover để kiểm tra đàm phán capability.',
          tool: 'mcp_apps_v2_negotiate',
          fields: [{ name: 'confirm', label: 'Tôi đã kiểm tra thông tin trên', type: 'checkbox', required: true }],
        },
      ],
    },
  },
];

/** Tìm template theo id (undefined khi không có). */
export function findGalleryTemplate(id: string): McpAppGalleryTemplate | undefined {
  return MCP_APP_GALLERY_TEMPLATES.find((t) => t.id === id);
}

/** Liệt kê template trong gallery (lọc theo kind khi cần). */
export function listGalleryTemplates(kind?: McpAppGalleryKind): McpAppGalleryTemplate[] {
  const list = kind
    ? MCP_APP_GALLERY_TEMPLATES.filter((t) => t.kind === kind)
    : [...MCP_APP_GALLERY_TEMPLATES];
  return list;
}

/** Tóm tắt gallery cho UI (không kèm example input nặng). */
export function summarizeGallery(): { id: string; kind: McpAppGalleryKind; title: string; description: string }[] {
  return MCP_APP_GALLERY_TEMPLATES.map((t) => ({
    id: t.id,
    kind: t.kind,
    title: t.title,
    description: t.description,
  }));
}

function validateValue(
  value: unknown,
  schema: GalleryInputProperty,
  path: string,
  errors: string[],
): void {
  if (value === undefined || value === null) return; // thiếu field xử lý ở tầng required
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${path}: phải là một trong [${schema.enum.join(', ')}]`);
    return;
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: phải là chuỗi`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}: phải là số`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: phải là true/false`);
      break;
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: phải là mảng`);
        break;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path}: cần ít nhất ${schema.minItems} mục`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path}: tối đa ${schema.maxItems} mục`);
      }
      if (schema.items) {
        value.forEach((item, i) => validateValue(item, schema.items!, `${path}[${i}]`, errors));
      }
      break;
    }
    case 'object': {
      if (!isRecord(value)) {
        errors.push(`${path}: phải là object`);
        break;
      }
      for (const req of schema.required ?? []) {
        if (value[req] === undefined) errors.push(`${path}.${req}: bắt buộc`);
      }
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        validateValue(value[key], prop, `${path}.${key}`, errors);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Kiểm tra input theo schema của template. Trả danh sách lỗi (rỗng =
 * hợp lệ). Không ném — caller quyết định báo lỗi hay render.
 */
export function validateGalleryInput(
  template: McpAppGalleryTemplate,
  input: unknown,
): string[] {
  const errors: string[] = [];
  if (!isRecord(input)) return ['input: phải là object'];
  for (const req of template.inputSchema.required ?? []) {
    if (input[req] === undefined) errors.push(`${req}: bắt buộc`);
  }
  for (const [key, prop] of Object.entries(template.inputSchema.properties)) {
    validateValue(input[key], prop, key, errors);
  }
  if (template.inputSchema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in template.inputSchema.properties)) errors.push(`${key}: field không có trong schema`);
    }
  }
  return errors;
}

function parseFormFields(raw: unknown): AppFormField[] {
  if (!Array.isArray(raw)) return [];
  const out: AppFormField[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = asNonEmptyString(entry['name']);
    const label = asNonEmptyString(entry['label']);
    const type = entry['type'];
    if (!name || !label) continue;
    if (
      type !== 'text' &&
      type !== 'number' &&
      type !== 'select' &&
      type !== 'checkbox' &&
      type !== 'textarea' &&
      type !== 'date'
    ) {
      continue;
    }
    const field: AppFormField = { name, label, type };
    if (typeof entry['required'] === 'boolean' && entry['required']) field.required = true;
    const placeholder = asNonEmptyString(entry['placeholder']);
    if (placeholder) field.placeholder = placeholder;
    if (Array.isArray(entry['options'])) {
      field.options = entry['options'].filter((o): o is string => typeof o === 'string');
    }
    out.push(field);
  }
  return out;
}

function renderDashboard(input: Record<string, unknown>): AppComponent[] {
  const title = asNonEmptyString(input['title']) ?? 'Dashboard';
  const components: AppComponent[] = [];
  const metrics = Array.isArray(input['metrics']) ? input['metrics'] : [];
  const metricComponents: AppComponent[] = [];
  for (const m of metrics.slice(0, 8)) {
    if (!isRecord(m)) continue;
    const label = asNonEmptyString(m['label']);
    const value = m['value'];
    if (!label || (typeof value !== 'string' && typeof value !== 'number')) continue;
    metricComponents.push({
      type: 'metric',
      label,
      value,
      ...(typeof m['delta'] === 'string' && m['delta'] !== '' ? { delta: m['delta'] } : {}),
    });
  }
  if (metricComponents.length > 0) {
    components.push({ type: 'grid', columns: Math.min(4, metricComponents.length), children: metricComponents });
  }
  const labels = Array.isArray(input['chartLabels'])
    ? input['chartLabels'].filter((v): v is string => typeof v === 'string')
    : [];
  const values = Array.isArray(input['chartValues'])
    ? input['chartValues'].filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : [];
  if (labels.length > 0 && values.length > 0) {
    const n = Math.min(labels.length, values.length, 60);
    components.push({
      type: 'chart-placeholder',
      title: `${title} — xu hướng`,
      kind: 'line',
      labels: labels.slice(0, n),
      values: values.slice(0, n),
    });
  }
  const columns = Array.isArray(input['tableColumns'])
    ? input['tableColumns'].filter((v): v is string => typeof v === 'string')
    : [];
  const rows = Array.isArray(input['tableRows'])
    ? input['tableRows']
        .filter((r): r is unknown[] => Array.isArray(r))
        .slice(0, 50)
        .map((r) => r.map((c) => (typeof c === 'string' || typeof c === 'number' ? c : String(c ?? ''))))
    : [];
  if (columns.length > 0 && rows.length > 0) {
    components.push({ type: 'table', title: 'Chi tiết mới nhất', columns, rows });
  }
  return components;
}

function renderForm(input: Record<string, unknown>): AppComponent[] {
  const title = asNonEmptyString(input['title']) ?? 'Form';
  const tool = asNonEmptyString(input['tool']) ?? 'mcp_apps_v2_gallery_render';
  const fields = parseFormFields(input['fields']);
  return [
    {
      type: 'form',
      title,
      tool,
      fields,
      ...(asNonEmptyString(input['description'])
        ? { description: asNonEmptyString(input['description']) }
        : {}),
      ...(asNonEmptyString(input['submitLabel'])
        ? { submitLabel: asNonEmptyString(input['submitLabel']) }
        : {}),
    },
  ];
}

function renderChart(input: Record<string, unknown>): AppComponent[] {
  const title = asNonEmptyString(input['title']) ?? 'Biểu đồ';
  const kind = input['kind'] === 'bar' ? 'bar' : 'line';
  const labels = Array.isArray(input['labels'])
    ? input['labels'].filter((v): v is string => typeof v === 'string')
    : [];
  const values = Array.isArray(input['values'])
    ? input['values'].filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : [];
  const n = Math.min(labels.length, values.length, 60);
  const components: AppComponent[] = [
    {
      type: 'chart-placeholder',
      title,
      kind,
      labels: labels.slice(0, n),
      values: values.slice(0, n),
      ...(asNonEmptyString(input['unit']) ? { unit: asNonEmptyString(input['unit']) } : {}),
    },
  ];
  if (n > 0) {
    components.push({
      type: 'table',
      title: asNonEmptyString(input['tableTitle']) ?? 'Số liệu gốc',
      columns: ['Nhãn', `Giá trị${asNonEmptyString(input['unit']) ? ` (${asNonEmptyString(input['unit'])})` : ''}`],
      rows: labels.slice(0, n).map((label, i) => [label, values[i]]),
    });
  }
  return components;
}

function renderWizard(input: Record<string, unknown>): AppComponent[] {
  const title = asNonEmptyString(input['title']) ?? 'Wizard';
  const steps = Array.isArray(input['steps']) ? input['steps'] : [];
  const currentStep = Math.max(
    0,
    Math.min(steps.length - 1, asNumber(input['currentStep']) ?? 0),
  );
  const step = isRecord(steps[currentStep]) ? (steps[currentStep] as Record<string, unknown>) : undefined;
  const components: AppComponent[] = [
    {
      type: 'card',
      title: `${title} — bước ${currentStep + 1}/${steps.length}`,
      description: `Tiến độ: ${steps.length > 0 ? Math.round(((currentStep + 1) / steps.length) * 100) : 0}%`,
      children: steps.map((s, i) => ({
        type: 'metric' as const,
        label: `Bước ${i + 1}`,
        value: i < currentStep ? 'xong' : i === currentStep ? 'đang làm' : 'chờ',
      })),
    },
  ];
  if (step) {
    const stepTitle = asNonEmptyString(step['title']) ?? `Bước ${currentStep + 1}`;
    const tool = asNonEmptyString(step['tool']) ?? 'mcp_apps_v2_gallery_render';
    components.push({
      type: 'form',
      title: stepTitle,
      tool,
      fields: parseFormFields(step['fields']),
      ...(asNonEmptyString(step['description'])
        ? { description: asNonEmptyString(step['description']) }
        : {}),
      submitLabel: currentStep + 1 < steps.length ? 'Tiếp tục' : 'Hoàn tất',
    });
  }
  return components;
}

/**
 * Render một template với input cho trước thành danh sách component
 * (dùng tiếp bởi `renderAppComponents` v1.13 để ra HTML). Ném
 * `GalleryTemplateError` khi template không tồn tại hoặc input sai schema.
 */
export function renderGalleryTemplate(
  templateId: string,
  input: unknown,
): { template: McpAppGalleryTemplate; components: AppComponent[] } {
  const template = findGalleryTemplate(templateId);
  if (!template) {
    throw new GalleryTemplateError(`Gallery: không có template "${templateId}"`, templateId);
  }
  const errors = validateGalleryInput(template, input);
  if (errors.length > 0) {
    throw new GalleryTemplateError(
      `Gallery: input của template "${templateId}" không hợp lệ: ${errors.join('; ')}`,
      templateId,
    );
  }
  const record = input as Record<string, unknown>;
  let components: AppComponent[];
  switch (template.kind) {
    case 'dashboard':
      components = renderDashboard(record);
      break;
    case 'form':
      components = renderForm(record);
      break;
    case 'chart':
      components = renderChart(record);
      break;
    case 'wizard':
      components = renderWizard(record);
      break;
    default:
      components = [];
  }
  for (const component of components) assertValidAppComponent(component);
  return { template, components };
}
