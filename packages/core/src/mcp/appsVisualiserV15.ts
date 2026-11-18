/**
 * MCP Apps auto-visualiser v15 — tự sinh chart / sankey / mermaid /
 * map từ dữ liệu tool trả về (SEP-1865 stable 2026-01-26, ideas only
 * — không copy code/text/tài sản của bất kỳ repo nào; học ý tưởng
 * auto-visualiser của Goose: dữ liệu có cấu trúc → chọn visualisation
 * phù hợp nhất thay vì bắt user tự vẽ).
 *
 * Luồng: tool trả dữ liệu (JSON) → `detectVisualisation` nhận diện
 * hình dạng → `build*Spec` tạo spec chuẩn → `renderVisualisation`
 * sinh HTML an toàn (SVG inline, không script ngoài, không fetch) +
 * text fallback đầy đủ cho client không render được.
 *
 * Các dạng nhận diện (theo thứ tự ưu tiên):
 *   1. `map` — mảng điểm `{ lat, lng, label? }` (tọa độ hợp lệ).
 *   2. `sankey` — mảng cạnh `{ from, to, value }` (luồng).
 *   3. `mermaid-flow` — mảng bước `{ id, label, next? }` hoặc đồ thị
 *      `{ nodes, edges }` (quy trình / sơ đồ).
 *   4. `pie-chart` — mảng `{ label, value }` 2–8 mục, tổng > 0.
 *   5. `line-chart` — mảng `{ label, value }` có thứ tự thời gian /
 *      số (label parse được thành số/ngày) và >= 3 điểm.
 *   6. `bar-chart` — mảng `{ label, value }` còn lại (>= 2 mục).
 *   7. `table` — mảng object đồng nhất (cùng keys) hoặc object phẳng.
 *   8. `none` — dữ liệu không có hình dạng vẽ được.
 *
 * Giới hạn an toàn: tối đa 200 hàng / 200 điểm / 100 cạnh — dữ liệu
 * lớn hơn thì lấy mẫu (top-N theo value) + ghi chú đã lấy mẫu.
 * HTML sinh ra không chứa `<script>`, không fetch ngoài, mọi chuỗi
 * đều escape — app hiển thị visualisation qua HTML này trong iframe
 * sandbox như app thường.
 */

export const MCP_APPS_V15_VISUALISER_VERSION = '15.0.0';
/** Số hàng/điểm tối đa trước khi lấy mẫu. */
export const UI_V15_VIS_MAX_ROWS = 200;
/** Số cạnh sankey tối đa. */
export const UI_V15_VIS_MAX_EDGES = 100;
/** Số node mermaid tối đa. */
export const UI_V15_VIS_MAX_NODES = 60;
/** Số cột table tối đa hiển thị. */
export const UI_V15_VIS_MAX_COLUMNS = 12;
/** Giá trị số tối đa (tránh Infinity/NaN lọt vào spec). */
export const UI_V15_VIS_MAX_VALUE = 1e15;

export class McpAppsVisualiserV15Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppsVisualiserV15Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Escape HTML cho chuỗi hiển thị trong visualisation. */
export function escapeHtmlV15(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Số hợp lệ để vẽ (finite, trong giới hạn). */
function isDrawableNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= UI_V15_VIS_MAX_VALUE
  );
}

/** Label hiển thị: string/number/boolean → chuỗi ngắn gọn. */
function toLabel(value: unknown): string {
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value).slice(0, 80);
}

/** Bảng màu phân biệt cho chart (đủ tương phản trên nền sáng/tối). */
export const UI_V15_CHART_COLORS = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#4f46e5',
  '#ea580c',
] as const;

/** Loại visualisation auto-visualiser sinh ra. */
export type UiV15VisualisationKind =
  | 'bar-chart'
  | 'line-chart'
  | 'pie-chart'
  | 'sankey'
  | 'mermaid-flow'
  | 'map'
  | 'table'
  | 'none';

/** Một điểm dữ liệu `{ label, value }` cho chart. */
export interface UiV15ChartPoint {
  label: string;
  value: number;
}

/** Spec chart cột / đường / tròn. */
export interface UiV15ChartSpec {
  kind: 'bar-chart' | 'line-chart' | 'pie-chart';
  title: string;
  points: UiV15ChartPoint[];
  /** Đơn vị giá trị (nếu dữ liệu ghi rõ). */
  unit?: string;
  /** true khi dữ liệu đã bị lấy mẫu (top-N). */
  sampled: boolean;
  totalPoints: number;
}

/** Một cạnh sankey `{ from, to, value }`. */
export interface UiV15SankeyEdge {
  from: string;
  to: string;
  value: number;
}

/** Spec sankey (luồng). */
export interface UiV15SankeySpec {
  kind: 'sankey';
  title: string;
  nodes: string[];
  edges: UiV15SankeyEdge[];
  sampled: boolean;
  totalEdges: number;
}

/** Một node mermaid flow. */
export interface UiV15FlowNode {
  id: string;
  label: string;
}

/** Một cạnh mermaid flow. */
export interface UiV15FlowEdge {
  from: string;
  to: string;
  label?: string;
}

/** Spec mermaid flowchart. */
export interface UiV15MermaidSpec {
  kind: 'mermaid-flow';
  title: string;
  direction: 'TD' | 'LR';
  nodes: UiV15FlowNode[];
  edges: UiV15FlowEdge[];
  /** Mã mermaid text (app có thể render bằng thư viện mermaid). */
  code: string;
  sampled: boolean;
}

/** Một điểm trên bản đồ. */
export interface UiV15MapPoint {
  lat: number;
  lng: number;
  label?: string;
}

/** Spec map (danh sách điểm + bbox). */
export interface UiV15MapSpec {
  kind: 'map';
  title: string;
  points: UiV15MapPoint[];
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  sampled: boolean;
  totalPoints: number;
}

/** Spec table. */
export interface UiV15TableSpec {
  kind: 'table';
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  sampled: boolean;
  totalRows: number;
}

/** Spec visualisation (hợp của mọi loại). */
export type UiV15VisualisationSpec =
  | UiV15ChartSpec
  | UiV15SankeySpec
  | UiV15MermaidSpec
  | UiV15MapSpec
  | UiV15TableSpec
  | { kind: 'none'; title: string };

/** Kết quả đầy đủ của auto-visualiser. */
export interface UiV15Visualisation {
  kind: UiV15VisualisationKind;
  title: string;
  spec: UiV15VisualisationSpec;
  /** HTML an toàn (SVG inline / bảng / code block mermaid). */
  html: string;
  /** Text fallback đầy đủ cho client không render được. */
  textFallback: string;
  /** Cảnh báo (đã lấy mẫu, dữ liệu bị bỏ, ...). */
  warnings: string[];
}

/** Tuỳ chọn cho auto-visualiser. */
export interface VisualiseOptions {
  /** Tiêu đề ghi đè (mặc định: suy ra từ dữ liệu). */
  title?: string;
  /** Ép loại visualisation (bỏ qua auto-detect). */
  forceKind?: UiV15VisualisationKind;
  /** Số mục tối đa giữ lại khi lấy mẫu (mặc định 200). */
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Nhận diện loại visualisation phù hợp nhất cho dữ liệu thô.
 * Trả 'none' khi dữ liệu không có hình dạng vẽ được — caller vẫn
 * nhận text fallback (JSON pretty) thay vì lỗi.
 */
export function detectVisualisation(data: unknown): UiV15VisualisationKind {
  if (Array.isArray(data)) {
    if (data.length === 0) return 'none';
    const items = data as unknown[];
    // Map: mọi item đều có lat/lng hợp lệ.
    if (
      items.every(
        (item) =>
          isRecord(item) &&
          isDrawableNumber(item['lat']) &&
          isDrawableNumber(item['lng']) &&
          (item['lat'] as number) >= -90 &&
          (item['lat'] as number) <= 90 &&
          (item['lng'] as number) >= -180 &&
          (item['lng'] as number) <= 180,
      )
    ) {
      return 'map';
    }
    // Sankey: mọi item đều có from/to/value.
    if (
      items.every(
        (item) =>
          isRecord(item) &&
          typeof item['from'] === 'string' &&
          typeof item['to'] === 'string' &&
          isDrawableNumber(item['value']),
      )
    ) {
      return 'sankey';
    }
    // Mermaid flow: mảng bước { id, label, next? } hoặc { nodes, edges }.
    if (
      items.every(
        (item) =>
          isRecord(item) &&
          typeof item['id'] === 'string' &&
          typeof item['label'] === 'string',
      )
    ) {
      return 'mermaid-flow';
    }
    // Chart: mảng { label, value }.
    if (
      items.every(
        (item) =>
          isRecord(item) &&
          (typeof item['label'] === 'string' || typeof item['label'] === 'number') &&
          isDrawableNumber(item['value']),
      )
    ) {
      const points = items as Record<string, unknown>[];
      // Line trước pie: chuỗi thời gian (nhãn date/số, >= 3 điểm) là
      // line-chart, không phải pie — pie chỉ dành cho đúng 2 hạng mục.
      if (points.length >= 3) {
        const labels = points.map((p) => String(p['label']));
        const ordered = labels.every(
          (label) => !Number.isNaN(Date.parse(label)) || !Number.isNaN(Number(label)),
        );
        if (ordered) return 'line-chart';
      }
      if (points.length === 2) {
        const total = points.reduce((sum, p) => sum + (p['value'] as number), 0);
        if (total > 0 && points.every((p) => (p['value'] as number) >= 0)) return 'pie-chart';
      }
      if (points.length >= 2) return 'bar-chart';
      return 'none';
    }
    // Table: mảng object đồng nhất (cùng keys, >= 2 cột).
    if (items.every((item) => isRecord(item))) {
      const keys = Object.keys(items[0] as Record<string, unknown>);
      if (keys.length >= 1 && keys.length <= UI_V15_VIS_MAX_COLUMNS) return 'table';
    }
    return 'none';
  }
  if (isRecord(data)) {
    // Đồ thị { nodes, edges }.
    if (Array.isArray(data['nodes']) && Array.isArray(data['edges'])) return 'mermaid-flow';
    // Object phẳng { key: value } → bar-chart khi value đều là số.
    const entries = Object.entries(data);
    if (
      entries.length >= 2 &&
      entries.every(([, value]) => isDrawableNumber(value))
    ) {
      return entries.length <= 8 ? 'pie-chart' : 'bar-chart';
    }
    if (entries.length >= 1) return 'table';
  }
  return 'none';
}

// ---------------------------------------------------------------------------
// Spec builders
// ---------------------------------------------------------------------------

/** Lấy mẫu top-N theo value (giữ thứ tự gốc khi value bằng nhau). */
function topNByValue<T>(items: T[], pick: (item: T) => number, max: number): { kept: T[]; sampled: boolean; total: number } {
  const total = items.length;
  if (total <= max) return { kept: items, sampled: false, total };
  const sorted = [...items].sort((a, b) => pick(b) - pick(a));
  return { kept: sorted.slice(0, max), sampled: true, total };
}

/** Trích mảng { label, value } từ dữ liệu chart. */
function extractChartPoints(data: unknown): UiV15ChartPoint[] {
  if (Array.isArray(data)) {
    return (data as Record<string, unknown>[])
      .filter((item) => isRecord(item) && isDrawableNumber(item['value']))
      .map((item) => ({
        label: toLabel(item['label'] ?? item['name'] ?? item['key'] ?? ''),
        value: item['value'] as number,
      }));
  }
  if (isRecord(data)) {
    return Object.entries(data)
      .filter(([, value]) => isDrawableNumber(value))
      .map(([label, value]) => ({ label, value: value as number }));
  }
  return [];
}

export function buildBarChartSpec(data: unknown, title: string, maxRows = UI_V15_VIS_MAX_ROWS): UiV15ChartSpec {
  const points = extractChartPoints(data);
  if (points.length < 2) {
    throw new McpAppsVisualiserV15Error(
      'Bar chart cần ít nhất 2 điểm { label, value }.',
      'ui-v15-vis-not-enough-points',
    );
  }
  const { kept, sampled, total } = topNByValue(points, (p) => p.value, maxRows);
  return { kind: 'bar-chart', title, points: kept, sampled, totalPoints: total };
}

export function buildLineChartSpec(data: unknown, title: string, maxRows = UI_V15_VIS_MAX_ROWS): UiV15ChartSpec {
  const points = extractChartPoints(data);
  if (points.length < 3) {
    throw new McpAppsVisualiserV15Error(
      'Line chart cần ít nhất 3 điểm { label, value } có thứ tự.',
      'ui-v15-vis-not-enough-points',
    );
  }
  const kept = points.length > maxRows ? points.slice(0, maxRows) : points;
  return {
    kind: 'line-chart',
    title,
    points: kept,
    sampled: points.length > maxRows,
    totalPoints: points.length,
  };
}

export function buildPieChartSpec(data: unknown, title: string, maxRows = 8): UiV15ChartSpec {
  const points = extractChartPoints(data);
  if (points.length < 2) {
    throw new McpAppsVisualiserV15Error(
      'Pie chart cần ít nhất 2 mục { label, value }.',
      'ui-v15-vis-not-enough-points',
    );
  }
  const { kept, sampled, total } = topNByValue(points, (p) => p.value, maxRows);
  const sum = kept.reduce((acc, p) => acc + p.value, 0);
  if (sum <= 0) {
    throw new McpAppsVisualiserV15Error(
      'Pie chart cần tổng giá trị > 0 (không vẽ được phần âm / tổng 0).',
      'ui-v15-vis-bad-pie-total',
    );
  }
  return { kind: 'pie-chart', title, points: kept, sampled, totalPoints: total };
}

export function buildSankeySpec(data: unknown, title: string, maxEdges = UI_V15_VIS_MAX_EDGES): UiV15SankeySpec {
  if (!Array.isArray(data)) {
    throw new McpAppsVisualiserV15Error('Sankey cần mảng cạnh { from, to, value }.', 'ui-v15-vis-bad-sankey');
  }
  const edges: UiV15SankeyEdge[] = (data as unknown[])
    .filter(
      (item) =>
        isRecord(item) &&
        typeof item['from'] === 'string' &&
        typeof item['to'] === 'string' &&
        isDrawableNumber(item['value']) &&
        (item['value'] as number) > 0,
    )
    .map((item) => {
      const rec = item as Record<string, unknown>;
      return { from: rec['from'] as string, to: rec['to'] as string, value: rec['value'] as number };
    });
  if (edges.length === 0) {
    throw new McpAppsVisualiserV15Error('Sankey cần ít nhất 1 cạnh { from, to, value > 0 }.', 'ui-v15-vis-bad-sankey');
  }
  const { kept, sampled, total } = topNByValue(edges, (e) => e.value, maxEdges);
  const nodes = [...new Set(kept.flatMap((e) => [e.from, e.to]))];
  return { kind: 'sankey', title, nodes, edges: kept, sampled, totalEdges: total };
}

/** Chuẩn hoá id node mermaid (chỉ chữ/số/gạch dưới). */
function mermaidNodeId(raw: string, index: number): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  return cleaned !== '' ? cleaned : `node${index}`;
}

export function buildMermaidSpec(data: unknown, title: string): UiV15MermaidSpec {
  let nodes: UiV15FlowNode[] = [];
  let edges: UiV15FlowEdge[] = [];
  let direction: 'TD' | 'LR' = 'TD';
  if (isRecord(data) && Array.isArray(data['nodes']) && Array.isArray(data['edges'])) {
    const rawNodes = data['nodes'] as unknown[];
    nodes = rawNodes
      .filter((n) => isRecord(n) && typeof n['id'] === 'string')
      .slice(0, UI_V15_VIS_MAX_NODES)
      .map((n, i) => {
        const rec = n as Record<string, unknown>;
        return { id: mermaidNodeId(rec['id'] as string, i), label: toLabel(rec['label'] ?? rec['id']) };
      });
    edges = (data['edges'] as unknown[])
      .filter((e) => isRecord(e) && typeof e['from'] === 'string' && typeof e['to'] === 'string')
      .slice(0, UI_V15_VIS_MAX_EDGES)
      .map((e) => {
        const rec = e as Record<string, unknown>;
        return {
          from: mermaidNodeId(rec['from'] as string, 0),
          to: mermaidNodeId(rec['to'] as string, 0),
          ...(typeof rec['label'] === 'string' ? { label: rec['label'] } : {}),
        };
      });
    if (data['direction'] === 'LR') direction = 'LR';
  } else if (Array.isArray(data)) {
    const steps = (data as unknown[]).filter(
      (item) => isRecord(item) && typeof item['id'] === 'string' && typeof item['label'] === 'string',
    ) as Record<string, unknown>[];
    nodes = steps.slice(0, UI_V15_VIS_MAX_NODES).map((s, i) => ({
      id: mermaidNodeId(s['id'] as string, i),
      label: toLabel(s['label']),
    }));
    const idByRaw = new Map<string, string>();
    steps.forEach((s, i) => idByRaw.set(s['id'] as string, mermaidNodeId(s['id'] as string, i)));
    steps.forEach((s) => {
      const next = s['next'];
      const targets = Array.isArray(next) ? next : typeof next === 'string' ? [next] : [];
      for (const target of targets) {
        const from = idByRaw.get(s['id'] as string);
        const to = idByRaw.get(String(target));
        if (from && to) edges.push({ from, to });
      }
    });
    // Không có next tường minh → nối bước liên tiếp thành chuỗi.
    if (edges.length === 0) {
      for (let i = 0; i + 1 < nodes.length; i += 1) {
        edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
      }
    }
  }
  if (nodes.length === 0) {
    throw new McpAppsVisualiserV15Error(
      'Mermaid flow cần ít nhất 1 node { id, label } hoặc { nodes, edges }.',
      'ui-v15-vis-bad-flow',
    );
  }
  const nodeLines = nodes.map((n) => `    ${n.id}["${n.label.replace(/"/g, "'")}"]`);
  const edgeLines = edges.map((e) =>
    e.label ? `    ${e.from} -->|${e.label.replace(/\|/g, '/')}| ${e.to}` : `    ${e.from} --> ${e.to}`,
  );
  const code = ['flowchart ' + direction, ...nodeLines, ...edgeLines].join('\n');
  return {
    kind: 'mermaid-flow',
    title,
    direction,
    nodes,
    edges,
    code,
    sampled: nodes.length >= UI_V15_VIS_MAX_NODES || edges.length >= UI_V15_VIS_MAX_EDGES,
  };
}

export function buildMapSpec(data: unknown, title: string, maxPoints = UI_V15_VIS_MAX_ROWS): UiV15MapSpec {
  if (!Array.isArray(data)) {
    throw new McpAppsVisualiserV15Error('Map cần mảng điểm { lat, lng, label? }.', 'ui-v15-vis-bad-map');
  }
  const points: UiV15MapPoint[] = (data as unknown[])
    .filter(
      (item) =>
        isRecord(item) &&
        isDrawableNumber(item['lat']) &&
        isDrawableNumber(item['lng']) &&
        (item['lat'] as number) >= -90 &&
        (item['lat'] as number) <= 90 &&
        (item['lng'] as number) >= -180 &&
        (item['lng'] as number) <= 180,
    )
    .map((item) => {
      const rec = item as Record<string, unknown>;
      return {
        lat: rec['lat'] as number,
        lng: rec['lng'] as number,
        ...(typeof rec['label'] === 'string' ? { label: rec['label'] } : {}),
      };
    });
  if (points.length === 0) {
    throw new McpAppsVisualiserV15Error('Map cần ít nhất 1 điểm { lat, lng } hợp lệ.', 'ui-v15-vis-bad-map');
  }
  const kept = points.length > maxPoints ? points.slice(0, maxPoints) : points;
  const lats = kept.map((p) => p.lat);
  const lngs = kept.map((p) => p.lng);
  return {
    kind: 'map',
    title,
    points: kept,
    bbox: {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
    },
    sampled: points.length > maxPoints,
    totalPoints: points.length,
  };
}

export function buildTableSpec(data: unknown, title: string, maxRows = UI_V15_VIS_MAX_ROWS): UiV15TableSpec {
  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(data)) {
    rows = (data as unknown[]).filter((item): item is Record<string, unknown> => isRecord(item));
  } else if (isRecord(data)) {
    rows = [data];
  }
  if (rows.length === 0) {
    throw new McpAppsVisualiserV15Error('Table cần ít nhất 1 hàng object.', 'ui-v15-vis-bad-table');
  }
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, UI_V15_VIS_MAX_COLUMNS);
  const kept = rows.length > maxRows ? rows.slice(0, maxRows) : rows;
  return { kind: 'table', title, columns, rows: kept, sampled: rows.length > maxRows, totalRows: rows.length };
}

// ---------------------------------------------------------------------------
// Rendering (HTML an toàn — SVG inline, không <script>)
// ---------------------------------------------------------------------------

function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e12) return String(value);
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function renderBarChartHtml(spec: UiV15ChartSpec): string {
  const width = 640;
  const height = 320;
  const padding = 48;
  const max = Math.max(...spec.points.map((p) => p.value), 1);
  const min = Math.min(0, ...spec.points.map((p) => p.value));
  const range = max - min || 1;
  const slot = (width - padding * 2) / spec.points.length;
  const barWidth = Math.max(8, Math.floor(slot * 0.6));
  const bars = spec.points
    .map((p, i) => {
      const h = Math.abs(p.value) / range * (height - padding * 2);
      const x = padding + i * slot + (slot - barWidth) / 2;
      const y = p.value >= 0 ? height - padding - h : height - padding;
      const color = UI_V15_CHART_COLORS[i % UI_V15_CHART_COLORS.length];
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth}" height="${Math.max(1, h).toFixed(1)}" fill="${color}"><title>${escapeHtmlV15(p.label)}: ${formatNumber(p.value)}</title></rect><text x="${(x + barWidth / 2).toFixed(1)}" y="${height - padding + 16}" font-size="11" text-anchor="middle">${escapeHtmlV15(p.label)}</text><text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="11" text-anchor="middle">${formatNumber(p.value)}</text>`;
    })
    .join('');
  return `<figure role="img" aria-label="${escapeHtmlV15(spec.title)}"><svg viewBox="0 0 ${width} ${height}" width="100%" xmlns="http://www.w3.org/2000/svg"><line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#888"/>${bars}</svg><figcaption>${escapeHtmlV15(spec.title)}</figcaption></figure>`;
}

function renderLineChartHtml(spec: UiV15ChartSpec): string {
  const width = 640;
  const height = 320;
  const padding = 48;
  const values = spec.points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const xs = spec.points.map((_, i) => padding + (i * (width - padding * 2)) / Math.max(1, spec.points.length - 1));
  const ys = values.map((v) => height - padding - ((v - min) / range) * (height - padding * 2));
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${(ys[i] as number).toFixed(1)}`).join(' ');
  const dots = xs
    .map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${(ys[i] as number).toFixed(1)}" r="4" fill="#2563eb"><title>${escapeHtmlV15(spec.points[i].label)}: ${formatNumber(values[i] as number)}</title></circle>`)
    .join('');
  const labels = xs
    .map((x, i) => `<text x="${x.toFixed(1)}" y="${height - padding + 16}" font-size="11" text-anchor="middle">${escapeHtmlV15(spec.points[i].label)}</text>`)
    .join('');
  return `<figure role="img" aria-label="${escapeHtmlV15(spec.title)}"><svg viewBox="0 0 ${width} ${height}" width="100%" xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="none" stroke="#2563eb" stroke-width="2"/>${dots}${labels}</svg><figcaption>${escapeHtmlV15(spec.title)}</figcaption></figure>`;
}

function renderPieChartHtml(spec: UiV15ChartSpec): string {
  const total = spec.points.reduce((sum, p) => sum + p.value, 0);
  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 120;
  let angle = -Math.PI / 2;
  const slices: string[] = [];
  const legend: string[] = [];
  spec.points.forEach((p, i) => {
    const frac = p.value / total;
    const sweep = frac * Math.PI * 2;
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(angle + sweep);
    const y2 = cy + radius * Math.sin(angle + sweep);
    const large = sweep > Math.PI ? 1 : 0;
    const color = UI_V15_CHART_COLORS[i % UI_V15_CHART_COLORS.length];
    slices.push(
      `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${radius},${radius} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}"><title>${escapeHtmlV15(p.label)}: ${formatNumber(p.value)} (${(frac * 100).toFixed(1)}%)</title></path>`,
    );
    legend.push(
      `<li><span style="display:inline-block;width:12px;height:12px;background:${color}"></span> ${escapeHtmlV15(p.label)} — ${formatNumber(p.value)} (${(frac * 100).toFixed(1)}%)</li>`,
    );
    angle += sweep;
  });
  return `<figure role="img" aria-label="${escapeHtmlV15(spec.title)}"><svg viewBox="0 0 ${size} ${size}" width="320" xmlns="http://www.w3.org/2000/svg">${slices.join('')}</svg><figcaption>${escapeHtmlV15(spec.title)}</figcaption><ul>${legend.join('')}</ul></figure>`;
}

function renderSankeyHtml(spec: UiV15SankeySpec): string {
  const max = Math.max(...spec.edges.map((e) => e.value), 1);
  const rows = spec.edges
    .map((e) => {
      const widthPct = Math.max(2, Math.round((e.value / max) * 100));
      return `<tr><td>${escapeHtmlV15(e.from)}</td><td>→</td><td>${escapeHtmlV15(e.to)}</td><td><span style="display:inline-block;height:14px;background:#2563eb;width:${widthPct}%"></span> ${formatNumber(e.value)}</td></tr>`;
    })
    .join('');
  return `<figure><table><caption>${escapeHtmlV15(spec.title)}</caption><thead><tr><th>Từ</th><th></th><th>Đến</th><th>Giá trị</th></tr></thead><tbody>${rows}</tbody></table><figcaption>Luồng: ${spec.nodes.length} node, ${spec.edges.length} cạnh.</figcaption></figure>`;
}

function renderMermaidHtml(spec: UiV15MermaidSpec): string {
  const steps = spec.nodes
    .map((n) => `<li><strong>${escapeHtmlV15(n.id)}</strong>: ${escapeHtmlV15(n.label)}</li>`)
    .join('');
  const flows = spec.edges
    .map((e) => `<li>${escapeHtmlV15(e.from)} → ${escapeHtmlV15(e.to)}${e.label ? ` (${escapeHtmlV15(e.label)})` : ''}</li>`)
    .join('');
  return `<figure><h3>${escapeHtmlV15(spec.title)}</h3><pre><code class="language-mermaid">${escapeHtmlV15(spec.code)}</code></pre><ul>${steps}</ul><ol>${flows}</ol><figcaption>Sơ đồ mermaid (${spec.direction === 'TD' ? 'dọc' : 'ngang'}): ${spec.nodes.length} bước, ${spec.edges.length} liên kết.</figcaption></figure>`;
}

function renderMapHtml(spec: UiV15MapSpec): string {
  const items = spec.points
    .map(
      (p) =>
        `<li>${p.label ? `${escapeHtmlV15(p.label)} — ` : ''}${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (<a href="https://www.openstreetmap.org/?mlat=${p.lat}&amp;mlon=${p.lng}#map=12/${p.lat}/${p.lng}" target="_blank" rel="noopener">mở bản đồ</a>)</li>`,
    )
    .join('');
  const { bbox } = spec;
  return `<figure><h3>${escapeHtmlV15(spec.title)}</h3><p>Khu vực: ${bbox.minLat.toFixed(4)}–${bbox.maxLat.toFixed(4)} vĩ độ, ${bbox.minLng.toFixed(4)}–${bbox.maxLng.toFixed(4)} kinh độ.</p><ul>${items}</ul><figcaption>${spec.points.length} điểm.</figcaption></figure>`;
}

function renderTableHtml(spec: UiV15TableSpec): string {
  const head = spec.columns.map((c) => `<th>${escapeHtmlV15(c)}</th>`).join('');
  const rows = spec.rows
    .map(
      (row) =>
        `<tr>${spec.columns.map((c) => `<td>${escapeHtmlV15(toLabel(row[c]))}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<figure><table><caption>${escapeHtmlV15(spec.title)}</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></figure>`;
}

/** Render HTML an toàn cho một spec (không <script>, không fetch). */
export function renderVisualisationHtml(spec: UiV15VisualisationSpec): string {
  switch (spec.kind) {
    case 'bar-chart':
      return renderBarChartHtml(spec);
    case 'line-chart':
      return renderLineChartHtml(spec);
    case 'pie-chart':
      return renderPieChartHtml(spec);
    case 'sankey':
      return renderSankeyHtml(spec);
    case 'mermaid-flow':
      return renderMermaidHtml(spec);
    case 'map':
      return renderMapHtml(spec);
    case 'table':
      return renderTableHtml(spec);
    case 'none':
      return `<p>${escapeHtmlV15(spec.title)} — dữ liệu không vẽ được thành biểu đồ.</p>`;
    default:
      return `<p>Không rõ loại visualisation.</p>`;
  }
}

// ---------------------------------------------------------------------------
// Text fallback
// ---------------------------------------------------------------------------

/** Text fallback đầy đủ cho một spec (client text-only vẫn thấy hết). */
export function buildTextFallback(spec: UiV15VisualisationSpec): string {
  const lines: string[] = [];
  switch (spec.kind) {
    case 'bar-chart':
    case 'line-chart':
    case 'pie-chart': {
      lines.push(`${spec.title} (${spec.kind}):`);
      const total = spec.points.reduce((s, p) => s + p.value, 0);
      for (const p of spec.points) {
        const pct = spec.kind === 'pie-chart' && total > 0 ? ` (${((p.value / total) * 100).toFixed(1)}%)` : '';
        lines.push(`- ${p.label}: ${formatNumber(p.value)}${pct}`);
      }
      if (spec.sampled) lines.push(`(Đã lấy mẫu: hiển thị ${spec.points.length}/${spec.totalPoints} mục.)`);
      break;
    }
    case 'sankey': {
      lines.push(`${spec.title} (sankey — luồng):`);
      for (const e of spec.edges) lines.push(`- ${e.from} → ${e.to}: ${formatNumber(e.value)}`);
      if (spec.sampled) lines.push(`(Đã lấy mẫu: hiển thị ${spec.edges.length}/${spec.totalEdges} cạnh.)`);
      break;
    }
    case 'mermaid-flow': {
      lines.push(`${spec.title} (sơ đồ quy trình):`);
      for (const n of spec.nodes) lines.push(`- Bước ${n.id}: ${n.label}`);
      for (const e of spec.edges) lines.push(`  ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`);
      lines.push('Mã mermaid:');
      lines.push(spec.code);
      break;
    }
    case 'map': {
      lines.push(`${spec.title} (bản đồ — ${spec.points.length} điểm):`);
      for (const p of spec.points) {
        lines.push(`- ${p.label ? `${p.label}: ` : ''}${p.lat}, ${p.lng}`);
      }
      if (spec.sampled) lines.push(`(Đã lấy mẫu: hiển thị ${spec.points.length}/${spec.totalPoints} điểm.)`);
      break;
    }
    case 'table': {
      lines.push(`${spec.title} (bảng — ${spec.totalRows} hàng):`);
      lines.push(spec.columns.join(' | '));
      for (const row of spec.rows) {
        lines.push(spec.columns.map((c) => toLabel(row[c])).join(' | '));
      }
      if (spec.sampled) lines.push(`(Đã lấy mẫu: hiển thị ${spec.rows.length}/${spec.totalRows} hàng.)`);
      break;
    }
    case 'none': {
      lines.push(`${spec.title}: dữ liệu không vẽ được thành biểu đồ — xem bản JSON.`);
      break;
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Auto-visualiser
// ---------------------------------------------------------------------------

/**
 * Auto-visualiser v15 — nhận dữ liệu thô, tự chọn loại visualisation
 * phù hợp nhất, build spec + HTML an toàn + text fallback.
 * Không bao giờ ném vì dữ liệu lạ: dữ liệu không vẽ được → kind
 * 'none' kèm text fallback là JSON pretty.
 */
export function visualiseData(data: unknown, options: VisualiseOptions = {}): UiV15Visualisation {
  const title = asNonEmptyString(options.title) ?? 'Kết quả trực quan';
  const warnings: string[] = [];
  const kind = options.forceKind ?? detectVisualisation(data);
  const maxRows = Math.max(1, Math.min(1000, options.maxRows ?? UI_V15_VIS_MAX_ROWS));
  try {
    let spec: UiV15VisualisationSpec;
    switch (kind) {
      case 'bar-chart':
        spec = buildBarChartSpec(data, title, maxRows);
        break;
      case 'line-chart':
        spec = buildLineChartSpec(data, title, maxRows);
        break;
      case 'pie-chart':
        spec = buildPieChartSpec(data, title, Math.min(8, maxRows));
        break;
      case 'sankey':
        spec = buildSankeySpec(data, title, UI_V15_VIS_MAX_EDGES);
        break;
      case 'mermaid-flow':
        spec = buildMermaidSpec(data, title);
        break;
      case 'map':
        spec = buildMapSpec(data, title, maxRows);
        break;
      case 'table':
        spec = buildTableSpec(data, title, maxRows);
        break;
      case 'none':
      default: {
        const fallback = JSON.stringify(data, null, 2).slice(0, 20_000);
        return {
          kind: 'none',
          title,
          spec: { kind: 'none', title },
          html: `<pre>${escapeHtmlV15(fallback)}</pre>`,
          textFallback: `${title}:\n${fallback}`,
          warnings,
        };
      }
    }
    if ('sampled' in spec && spec.sampled) {
      warnings.push('Dữ liệu đã được lấy mẫu (giới hạn hiển thị) — xem text fallback để biết tổng số.');
    }
    return {
      kind,
      title,
      spec,
      html: renderVisualisationHtml(spec),
      textFallback: buildTextFallback(spec),
      warnings,
    };
  } catch (err) {
    // Spec build lỗi (vd pie tổng 0) → rơi về table nếu được, nếu
    // không thì 'none' kèm JSON — không bao giờ crash host.
    if (kind !== 'table') {
      try {
        const tableSpec = buildTableSpec(data, title, maxRows);
        return {
          kind: 'table',
          title,
          spec: tableSpec,
          html: renderVisualisationHtml(tableSpec),
          textFallback: buildTextFallback(tableSpec),
          warnings: [...warnings, `Không vẽ được ${kind} (${err instanceof Error ? err.message : String(err)}) — đã rơi về bảng.`],
        };
      } catch {
        // Bỏ qua — rơi xuống 'none' bên dưới.
      }
    }
    const fallback = JSON.stringify(data, null, 2).slice(0, 20_000);
    return {
      kind: 'none',
      title,
      spec: { kind: 'none', title },
      html: `<pre>${escapeHtmlV15(fallback)}</pre>`,
      textFallback: `${title}:\n${fallback}`,
      warnings: [...warnings, `Không vẽ được ${kind}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Class bọc auto-visualiser (giữ thống kê + cho phép ép kind mặc
 * định). Host v15 dùng class này để visualise kết quả tool.
 */
export class AutoVisualiserV15 {
  private visualised = 0;
  private byKind = new Map<UiV15VisualisationKind, number>();

  visualise(data: unknown, options: VisualiseOptions = {}): UiV15Visualisation {
    const result = visualiseData(data, options);
    this.visualised += 1;
    this.byKind.set(result.kind, (this.byKind.get(result.kind) ?? 0) + 1);
    return result;
  }

  stats(): { total: number; byKind: Record<string, number> } {
    return {
      total: this.visualised,
      byKind: Object.fromEntries(this.byKind),
    };
  }
}
