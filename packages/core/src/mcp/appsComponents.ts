/**
 * MCP Apps host v13 — component kit chuẩn cho app đơn giản (ideas only).
 *
 * Server không muốn viết HTML tay có thể trả về một danh sách component
 * khai báo, host render thành HTML an toàn (mọi text đều escape, không
 * có JS tuỳ ý từ server):
 *
 *   - `card` — thẻ tiêu đề + mô tả + (tuỳ chọn) hành động gọi tool.
 *   - `table` — bảng dữ liệu (cột + hàng, tối đa 50 hàng / 20 cột).
 *   - `metric` — số liệu lớn + nhãn + delta (tăng/giảm) + đơn vị.
 *   - `form` — form nhập liệu (text/number/select/checkbox/textarea/
 *     date) — submit gọi tool qua dialect `ui/` (không có form action).
 *   - `list` — danh sách item (tiêu đề + mô tả + badge, tối đa 200).
 *   - `chart-placeholder` — biểu đồ SVG thuần (bar/line) vẽ từ dữ liệu
 *     số, không cần thư viện ngoài (app phức tạp tự vẽ bằng HTML).
 *   - `stack` / `grid` — container xếp component con (tối đa 3 tầng lồng).
 *   - `html` — escape hatch: HTML đầy đủ cho app phức tạp, vẫn phải
 *     qua `validateAppHtml` (chặn script ngoài, storage, parent access).
 *
 * Kèm theo client shim (`buildAppClientShim`) — đoạn JS nhỏ app nhúng
 * để nói dialect JSON-RPC `ui/` với host: `initialize`, `callTool`
 * (`tools/call`), `openLink` (`ui/open-link`), `sendMessage`
 * (`ui/message`), nhận `ui/model-context-updated`. Shim tự nó phải
 * qua `validateAppHtml`: chỉ dùng `parent.postMessage(msg,
 * window.location.origin)` (không `window.parent`, không `'*'`),
 * không fetch, không storage, không eval.
 */

import { validateAppHtml } from './apps';

/** Độ sâu lồng container tối đa. */
export const APP_COMPONENT_MAX_DEPTH = 3;
/** Số component tối đa trong một lần render. */
export const APP_COMPONENT_MAX_COUNT = 100;
/** Số hàng tối đa của table / item tối đa của list. */
export const APP_COMPONENT_MAX_TABLE_ROWS = 50;
export const APP_COMPONENT_MAX_TABLE_COLS = 20;
export const APP_COMPONENT_MAX_LIST_ITEMS = 200;
/** Số field tối đa của form. */
export const APP_COMPONENT_MAX_FORM_FIELDS = 20;
/** Số điểm tối đa của chart-placeholder. */
export const APP_COMPONENT_MAX_CHART_POINTS = 60;
/** Độ dài tối đa của text trong component (ký tự). */
export const APP_COMPONENT_MAX_TEXT_CHARS = 2000;

export class AppComponentError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AppComponentError';
    this.code = code;
  }
}

/** Nút hành động trên card: gọi tool qua host. */
export interface AppComponentAction {
  label: string;
  tool: string;
  /** Arguments gửi kèm khi gọi tool (JSON thuần). */
  arguments?: Record<string, unknown>;
}

/** Một field của form. */
export interface AppFormField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'checkbox' | 'textarea' | 'date';
  required?: boolean;
  placeholder?: string;
  /** Lựa chọn (chỉ cho type select). */
  options?: string[];
  /** Giá trị mặc định. */
  defaultValue?: string | number | boolean;
}

export type AppComponent =
  | { type: 'card'; title: string; description?: string; badge?: string; actions?: AppComponentAction[]; children?: AppComponent[] }
  | { type: 'table'; title?: string; columns: string[]; rows: (string | number)[][]; caption?: string }
  | { type: 'metric'; label: string; value: string | number; unit?: string; delta?: string; trend?: 'up' | 'down' | 'flat' }
  | { type: 'form'; title?: string; tool: string; fields: AppFormField[]; submitLabel?: string; description?: string }
  | { type: 'list'; title?: string; items: { title: string; description?: string; badge?: string }[] }
  | { type: 'chart-placeholder'; title?: string; kind: 'bar' | 'line'; labels: string[]; values: number[]; unit?: string }
  | { type: 'stack'; direction?: 'vertical' | 'horizontal'; gap?: number; children: AppComponent[] }
  | { type: 'grid'; columns?: number; children: AppComponent[] }
  | { type: 'html'; html: string };

export const APP_COMPONENT_TYPES = [
  'card',
  'table',
  'metric',
  'form',
  'list',
  'chart-placeholder',
  'stack',
  'grid',
  'html',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Escape text để chèn an toàn vào HTML. */
export function escapeAppComponentText(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape text để chèn vào thuộc tính HTML (đã escape quote). */
export function escapeAppComponentAttr(value: string): string {
  return escapeAppComponentText(value);
}

function checkText(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    errors.push(`${field} phải là chuỗi.`);
    return undefined;
  }
  if (value.length > APP_COMPONENT_MAX_TEXT_CHARS) {
    errors.push(`${field} quá dài (tối đa ${APP_COMPONENT_MAX_TEXT_CHARS} ký tự).`);
    return undefined;
  }
  return value;
}

/**
 * Validate một component (đệ quy cho container, tối đa
 * `APP_COMPONENT_MAX_DEPTH` tầng). Trả danh sách lỗi (rỗng = hợp lệ).
 * Không throw — để host gom lỗi rồi trả về server.
 */
export function validateAppComponent(component: unknown, depth = 0, errors: string[] = []): string[] {
  if (!isRecord(component)) {
    errors.push('Component phải là object.');
    return errors;
  }
  const type = component['type'];
  if (typeof type !== 'string' || !(APP_COMPONENT_TYPES as readonly string[]).includes(type)) {
    errors.push(`Component type không rõ: ${String(type)} (cho phép: ${APP_COMPONENT_TYPES.join(', ')}).`);
    return errors;
  }
  if (depth > APP_COMPONENT_MAX_DEPTH) {
    errors.push(`Component lồng quá sâu (tối đa ${APP_COMPONENT_MAX_DEPTH} tầng).`);
    return errors;
  }
  switch (type) {
    case 'card': {
      checkText(component['title'], 'card.title', errors);
      if (asNonEmptyString(component['title']) === undefined) errors.push('card cần title.');
      checkText(component['description'], 'card.description', errors);
      checkText(component['badge'], 'card.badge', errors);
      const actions = component['actions'];
      if (actions !== undefined) {
        if (!Array.isArray(actions) || actions.length > 5) {
          errors.push('card.actions phải là mảng tối đa 5 action.');
        } else {
          for (const action of actions) {
            if (!isRecord(action) || asNonEmptyString(action['label']) === undefined || asNonEmptyString(action['tool']) === undefined) {
              errors.push('card action cần label và tool.');
            }
          }
        }
      }
      validateChildren(component['children'], depth, errors);
      break;
    }
    case 'table': {
      const columns = component['columns'];
      const rows = component['rows'];
      if (!Array.isArray(columns) || columns.length === 0 || columns.length > APP_COMPONENT_MAX_TABLE_COLS) {
        errors.push(`table cần 1..${APP_COMPONENT_MAX_TABLE_COLS} cột.`);
      } else if (columns.some((c) => typeof c !== 'string')) {
        errors.push('table.columns phải là mảng chuỗi.');
      }
      if (!Array.isArray(rows) || rows.length > APP_COMPONENT_MAX_TABLE_ROWS) {
        errors.push(`table cần tối đa ${APP_COMPONENT_MAX_TABLE_ROWS} hàng.`);
      } else {
        for (const row of rows) {
          if (!Array.isArray(row) || (Array.isArray(columns) && row.length !== columns.length)) {
            errors.push('table: mỗi hàng phải có đúng số ô bằng số cột.');
            break;
          }
          if (row.some((cell) => typeof cell !== 'string' && typeof cell !== 'number')) {
            errors.push('table: ô chỉ nhận chuỗi hoặc số.');
            break;
          }
        }
      }
      checkText(component['title'], 'table.title', errors);
      checkText(component['caption'], 'table.caption', errors);
      break;
    }
    case 'metric': {
      if (asNonEmptyString(component['label']) === undefined) errors.push('metric cần label.');
      const value = component['value'];
      if (typeof value !== 'string' && typeof value !== 'number') errors.push('metric cần value là chuỗi hoặc số.');
      checkText(component['unit'], 'metric.unit', errors);
      checkText(component['delta'], 'metric.delta', errors);
      const trend = component['trend'];
      if (trend !== undefined && trend !== 'up' && trend !== 'down' && trend !== 'flat') {
        errors.push('metric.trend phải là up, down hoặc flat.');
      }
      break;
    }
    case 'form': {
      if (asNonEmptyString(component['tool']) === undefined) errors.push('form cần tool để submit.');
      const fields = component['fields'];
      if (!Array.isArray(fields) || fields.length === 0 || fields.length > APP_COMPONENT_MAX_FORM_FIELDS) {
        errors.push(`form cần 1..${APP_COMPONENT_MAX_FORM_FIELDS} field.`);
      } else {
        const names = new Set<string>();
        for (const field of fields) {
          if (!isRecord(field)) {
            errors.push('form field phải là object.');
            continue;
          }
          const name = asNonEmptyString(field['name']);
          if (name === undefined) errors.push('form field cần name.');
          else if (names.has(name)) errors.push(`form field trùng name: ${name}.`);
          else names.add(name);
          if (asNonEmptyString(field['label']) === undefined) errors.push('form field cần label.');
          const ftype = field['type'];
          if (!['text', 'number', 'select', 'checkbox', 'textarea', 'date'].includes(String(ftype ?? ''))) {
            errors.push(`form field type không rõ: ${String(ftype)}.`);
          }
          if (ftype === 'select') {
            const options = field['options'];
            if (!Array.isArray(options) || options.length === 0 || options.some((o) => typeof o !== 'string')) {
              errors.push('form field select cần options là mảng chuỗi không rỗng.');
            }
          }
        }
      }
      checkText(component['title'], 'form.title', errors);
      checkText(component['description'], 'form.description', errors);
      checkText(component['submitLabel'], 'form.submitLabel', errors);
      break;
    }
    case 'list': {
      const items = component['items'];
      if (!Array.isArray(items) || items.length > APP_COMPONENT_MAX_LIST_ITEMS) {
        errors.push(`list cần tối đa ${APP_COMPONENT_MAX_LIST_ITEMS} item.`);
      } else {
        for (const item of items) {
          if (!isRecord(item) || asNonEmptyString(item['title']) === undefined) {
            errors.push('list item cần title.');
            break;
          }
          checkText(item['description'], 'list item.description', errors);
          checkText(item['badge'], 'list item.badge', errors);
        }
      }
      checkText(component['title'], 'list.title', errors);
      break;
    }
    case 'chart-placeholder': {
      const kind = component['kind'];
      if (kind !== 'bar' && kind !== 'line') errors.push('chart-placeholder kind phải là bar hoặc line.');
      const labels = component['labels'];
      const values = component['values'];
      if (!Array.isArray(labels) || !Array.isArray(values) || labels.length === 0 || labels.length !== values.length) {
        errors.push('chart-placeholder cần labels và values cùng độ dài, không rỗng.');
      } else {
        if (labels.length > APP_COMPONENT_MAX_CHART_POINTS) {
          errors.push(`chart-placeholder tối đa ${APP_COMPONENT_MAX_CHART_POINTS} điểm.`);
        }
        if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
          errors.push('chart-placeholder values phải là số hữu hạn.');
        }
        if (labels.some((l) => typeof l !== 'string')) {
          errors.push('chart-placeholder labels phải là chuỗi.');
        }
      }
      checkText(component['title'], 'chart-placeholder.title', errors);
      checkText(component['unit'], 'chart-placeholder.unit', errors);
      break;
    }
    case 'stack':
    case 'grid': {
      validateChildren(component['children'], depth, errors);
      if (type === 'grid') {
        const columns = component['columns'];
        if (columns !== undefined && (typeof columns !== 'number' || columns < 1 || columns > 6)) {
          errors.push('grid.columns phải là số 1..6.');
        }
      }
      if (type === 'stack') {
        const direction = component['direction'];
        if (direction !== undefined && direction !== 'vertical' && direction !== 'horizontal') {
          errors.push('stack.direction phải là vertical hoặc horizontal.');
        }
      }
      break;
    }
    case 'html': {
      const html = component['html'];
      if (typeof html !== 'string' || html.trim() === '') {
        errors.push('html escape hatch cần chuỗi HTML không rỗng.');
      } else {
        const validation = validateAppHtml(html);
        if (!validation.valid) {
          const first = validation.findings.find((f) => f.severity === 'blocking');
          errors.push(`html escape hatch bị chặn: ${first?.message ?? 'validation failed.'}`);
        }
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

function validateChildren(children: unknown, depth: number, errors: string[]): void {
  if (children === undefined) return;
  if (!Array.isArray(children) || children.length === 0) {
    errors.push('children phải là mảng component không rỗng.');
    return;
  }
  if (children.length > APP_COMPONENT_MAX_COUNT) {
    errors.push(`children tối đa ${APP_COMPONENT_MAX_COUNT} component.`);
    return;
  }
  for (const child of children) validateAppComponent(child, depth + 1, errors);
}

/** Ném `AppComponentError` khi component không hợp lệ. */
export function assertValidAppComponent(component: unknown): asserts component is AppComponent {
  const errors = validateAppComponent(component);
  if (errors.length > 0) {
    throw new AppComponentError(`Component không hợp lệ: ${errors.join('; ')}`, 'component-invalid');
  }
}

/** Đếm số component trong cây (kể cả container con). */
export function countAppComponents(component: AppComponent): number {
  let count = 1;
  const children = (component as { children?: AppComponent[] }).children;
  if (Array.isArray(children)) {
    for (const child of children) count += countAppComponents(child);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** CSS dùng chung cho component kit (theme qua CSS vars do host đặt). */
export const APP_COMPONENT_KIT_CSS = [
  ':root{--ob-bg:#ffffff;--ob-fg:#1a1a1a;--ob-muted:#666666;--ob-border:#dddddd;--ob-accent:#2563eb;--ob-card:#f8f8f8;--ob-good:#15803d;--ob-bad:#b91c1c;}',
  '[data-theme="dark"]{--ob-bg:#1a1a1a;--ob-fg:#f0f0f0;--ob-muted:#aaaaaa;--ob-border:#444444;--ob-accent:#60a5fa;--ob-card:#242424;--ob-good:#4ade80;--ob-bad:#f87171;}',
  'body{margin:0;padding:12px;background:var(--ob-bg);color:var(--ob-fg);font:14px/1.5 system-ui,sans-serif;}',
  '.ob-stack{display:flex;flex-direction:column;gap:12px;}',
  '.ob-stack-h{display:flex;flex-direction:row;gap:12px;flex-wrap:wrap;}',
  '.ob-grid{display:grid;gap:12px;}',
  '.ob-card{background:var(--ob-card);border:1px solid var(--ob-border);border-radius:10px;padding:14px;}',
  '.ob-card h2{margin:0 0 6px;font-size:16px;}',
  '.ob-card p{margin:0 0 8px;color:var(--ob-muted);}',
  '.ob-badge{display:inline-block;background:var(--ob-accent);color:#fff;border-radius:999px;padding:1px 8px;font-size:12px;}',
  '.ob-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}',
  '.ob-actions button,.ob-form button{background:var(--ob-accent);color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;}',
  '.ob-actions button:disabled,.ob-form button:disabled{opacity:.6;cursor:wait;}',
  '.ob-metric .ob-value{font-size:28px;font-weight:700;}',
  '.ob-metric .ob-label{color:var(--ob-muted);font-size:13px;}',
  '.ob-metric .ob-delta-up{color:var(--ob-good);} .ob-metric .ob-delta-down{color:var(--ob-bad);}',
  '.ob-table{width:100%;border-collapse:collapse;}',
  '.ob-table th,.ob-table td{border:1px solid var(--ob-border);padding:6px 8px;text-align:left;}',
  '.ob-table th{background:var(--ob-card);}',
  '.ob-table caption{text-align:left;font-weight:600;margin-bottom:6px;}',
  '.ob-list{list-style:none;margin:0;padding:0;}',
  '.ob-list li{border-bottom:1px solid var(--ob-border);padding:8px 0;}',
  '.ob-list li:last-child{border-bottom:0;}',
  '.ob-form label{display:block;margin-bottom:10px;}',
  '.ob-form label span{display:block;font-weight:600;margin-bottom:4px;}',
  '.ob-form input,.ob-form select,.ob-form textarea{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--ob-border);border-radius:6px;background:var(--ob-bg);color:var(--ob-fg);font:inherit;}',
  '.ob-result{white-space:pre-wrap;background:var(--ob-card);border:1px solid var(--ob-border);border-radius:6px;padding:8px;margin-top:8px;}',
  '.ob-chart{width:100%;height:auto;display:block;}',
  '.ob-title{font-size:15px;font-weight:700;margin:0 0 8px;}',
].join('\n');

/**
 * Client shim — đoạn JS app nhúng để nói dialect `ui/` với host.
 * API: `window.__openbot.initialize(clientInfo)`,
 * `callTool(name, args)`, `openLink(url)`, `sendMessage(msg, level)`,
 * `updateModelContext(ctx)`, `onModelContext(cb)`, `close()`,
 * `setDisplayMode(mode)`. Mọi call đều là JSON-RPC 2.0 qua
 * `parent.postMessage(msg, window.location.origin)` với id tăng dần
 * và timeout 30s; response lỗi trả về Error.
 */
export function buildAppClientShim(): string {
  return [
    '(function(){',
    '  var nextId = 1;',
    '  var pending = {};',
    '  var modelContextHandlers = [];',
    '  var messageHandlers = [];',
    '  var initialized = false;',
    '  function post(msg){ parent.postMessage(msg, window.location.origin); }',
    '  function call(method, params){',
    '    return new Promise(function(resolve, reject){',
    '      var id = "rpc-" + (nextId++);',
    '      var timer = setTimeout(function(){ delete pending[id]; reject(new Error("Timeout waiting for host: " + method)); }, 30000);',
    '      pending[id] = { resolve: resolve, reject: reject, timer: timer };',
    '      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });',
    '    });',
    '  }',
    '  function notify(method, params){ post({ jsonrpc: "2.0", method: method, params: params || {} }); }',
    '  window.addEventListener("message", function(event){',
    '    var data = event.data;',
    '    if (!data || typeof data !== "object") return;',
    '    if (data.jsonrpc === "2.0" && data.id && pending[data.id]) {',
    '      var entry = pending[data.id];',
    '      delete pending[data.id];',
    '      clearTimeout(entry.timer);',
    '      if (data.error) entry.reject(new Error(data.error.message || "Host error"));',
    '      else entry.resolve(data.result);',
    '      return;',
    '    }',
    '    if (data.jsonrpc === "2.0" && data.method === "ui/model-context-updated") {',
    '      var ctx = (data.params && data.params.context) || {};',
    '      modelContextHandlers.forEach(function(cb){ try { cb(ctx); } catch (e) {} });',
    '      return;',
    '    }',
    '    if (data.jsonrpc === "2.0" && data.method === "ui/message") {',
    '      var msg = (data.params && data.params.message) || "";',
    '      messageHandlers.forEach(function(cb){ try { cb(msg); } catch (e) {} });',
    '      return;',
    '    }',
    '  });',
    '  function bindForms(){',
    '    var forms = document.querySelectorAll("form[data-ob-tool]");',
    '    forms.forEach(function(form){',
    '      form.addEventListener("submit", function(ev){',
    '        ev.preventDefault();',
    '        var tool = form.getAttribute("data-ob-tool") || "";',
    '        var args = {};',
    '        var data = new FormData(form);',
    '        data.forEach(function(value, key){ args[key] = value; });',
    '        form.querySelectorAll("input[type=checkbox]").forEach(function(box){ args[box.name] = box.checked; });',
    '        var resultEl = form.parentElement ? form.parentElement.querySelector("[data-ob-result]") : null;',
    '        var btn = form.querySelector("button[type=submit]");',
    '        if (btn) btn.disabled = true;',
    '        call("tools/call", { name: tool, arguments: args }).then(function(res){',
    '          if (resultEl) resultEl.textContent = JSON.stringify(res, null, 2);',
    '        }).catch(function(err){',
    '          if (resultEl) resultEl.textContent = "Error: " + err.message;',
    '        }).finally(function(){ if (btn) btn.disabled = false; });',
    '      });',
    '    });',
    '    var actionBtns = document.querySelectorAll("[data-ob-action-tool]");',
    '    actionBtns.forEach(function(btn){',
    '      btn.addEventListener("click", function(){',
    '        var tool = btn.getAttribute("data-ob-action-tool") || "";',
    '        var argsRaw = btn.getAttribute("data-ob-action-args") || "{}";',
    '        var args = {};',
    '        try { args = JSON.parse(argsRaw); } catch (e) { args = {}; }',
    '        btn.disabled = true;',
    '        call("tools/call", { name: tool, arguments: args }).then(function(res){',
    '          var target = btn.getAttribute("data-ob-action-result");',
    '          var el = target ? document.getElementById(target) : null;',
    '          if (el) el.textContent = JSON.stringify(res, null, 2);',
    '        }).catch(function(err){',
    '          var target2 = btn.getAttribute("data-ob-action-result");',
    '          var el2 = target2 ? document.getElementById(target2) : null;',
    '          if (el2) el2.textContent = "Error: " + err.message;',
    '        }).finally(function(){ btn.disabled = false; });',
    '      });',
    '    });',
    '  }',
    '  window.__openbot = {',
    '    initialize: function(clientInfo){ initialized = true; return call("ui/initialize", { clientInfo: clientInfo || {} }); },',
    '    isInitialized: function(){ return initialized; },',
    '    callTool: function(name, args){ return call("tools/call", { name: name, arguments: args || {} }); },',
    '    openLink: function(url){ return call("ui/open-link", { url: url }); },',
    '    sendMessage: function(message, level){ return call("ui/message", { message: message, level: level || "info" }); },',
    '    updateModelContext: function(context){ return call("ui/update-model-context", { context: context || {} }); },',
    '    close: function(){ return call("ui/close", {}); },',
    '    setDisplayMode: function(mode){ return call("ui/set-display-mode", { mode: mode }); },',
    '    onModelContext: function(cb){ modelContextHandlers.push(cb); },',
    '    onMessage: function(cb){ messageHandlers.push(cb); },',
    '  };',
    '  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", bindForms); }',
    '  else { bindForms(); }',
    '})();',
  ].join('\n');
}

let actionResultCounter = 0;

/** Render một component thành HTML (đã validate trước — lỗi thì throw). */
export function renderAppComponent(component: AppComponent): string {
  assertValidAppComponent(component);
  return renderComponentInner(component);
}

function renderChildren(children: AppComponent[] | undefined): string {
  if (!children) return '';
  return children.map((child) => renderComponentInner(child)).join('\n');
}

function renderComponentInner(component: AppComponent): string {
  switch (component.type) {
    case 'card': {
      actionResultCounter += 1;
      const resultId = `ob-action-result-${actionResultCounter}`;
      const actions = (component.actions ?? [])
        .map(
          (a) =>
            `<button type="button" data-ob-action-tool="${escapeAppComponentAttr(a.tool)}" data-ob-action-args="${escapeAppComponentAttr(JSON.stringify(a.arguments ?? {}))}" data-ob-action-result="${resultId}">${escapeAppComponentText(a.label)}</button>`,
        )
        .join('');
      return [
        '<div class="ob-card">',
        `<h2>${escapeAppComponentText(component.title)}</h2>`,
        component.badge ? `<span class="ob-badge">${escapeAppComponentText(component.badge)}</span>` : '',
        component.description ? `<p>${escapeAppComponentText(component.description)}</p>` : '',
        renderChildren(component.children),
        actions ? `<div class="ob-actions">${actions}</div><pre class="ob-result" id="${resultId}" data-ob-result hidden></pre>` : '',
        '</div>',
      ]
        .filter((part) => part !== '')
        .join('\n');
    }
    case 'table': {
      const head = component.columns.map((c) => `<th>${escapeAppComponentText(c)}</th>`).join('');
      const body = component.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${escapeAppComponentText(cell)}</td>`).join('')}</tr>`,
        )
        .join('\n');
      return [
        '<div class="ob-card"><table class="ob-table">',
        component.caption ? `<caption>${escapeAppComponentText(component.caption)}</caption>` : '',
        component.title ? `<caption>${escapeAppComponentText(component.title)}</caption>` : '',
        `<thead><tr>${head}</tr></thead>`,
        `<tbody>${body}</tbody>`,
        '</table></div>',
      ]
        .filter((part) => part !== '')
        .join('\n');
    }
    case 'metric': {
      const trendClass =
        component.trend === 'up' ? 'ob-delta-up' : component.trend === 'down' ? 'ob-delta-down' : '';
      return [
        '<div class="ob-card ob-metric">',
        `<div class="ob-label">${escapeAppComponentText(component.label)}</div>`,
        `<div class="ob-value">${escapeAppComponentText(component.value)}${component.unit ? ` <span style="font-size:16px">${escapeAppComponentText(component.unit)}</span>` : ''}</div>`,
        component.delta ? `<div class="${trendClass}">${escapeAppComponentText(component.delta)}</div>` : '',
        '</div>',
      ]
        .filter((part) => part !== '')
        .join('\n');
    }
    case 'form': {
      const fields = component.fields
        .map((field) => {
          const label = `<span>${escapeAppComponentText(field.label)}${field.required ? ' *' : ''}</span>`;
          const common = `name="${escapeAppComponentAttr(field.name)}"${field.required ? ' required' : ''}`;
          const placeholder = field.placeholder
            ? ` placeholder="${escapeAppComponentAttr(field.placeholder)}"`
            : '';
          const def = field.defaultValue;
          switch (field.type) {
            case 'select':
              return `<label>${label}<select ${common}>${(field.options ?? [])
                .map(
                  (o) =>
                    `<option value="${escapeAppComponentAttr(o)}"${def === o ? ' selected' : ''}>${escapeAppComponentText(o)}</option>`,
                )
                .join('')}</select></label>`;
            case 'textarea':
              return `<label>${label}<textarea ${common}${placeholder}>${def !== undefined ? escapeAppComponentText(String(def)) : ''}</textarea></label>`;
            case 'checkbox':
              return `<label><input type="checkbox" ${common}${def === true ? ' checked' : ''}> ${escapeAppComponentText(field.label)}</label>`;
            case 'number':
              return `<label>${label}<input type="number" ${common}${placeholder}${typeof def === 'number' ? ` value="${def}"` : ''}></label>`;
            case 'date':
              return `<label>${label}<input type="date" ${common}${typeof def === 'string' ? ` value="${escapeAppComponentAttr(def)}"` : ''}></label>`;
            case 'text':
            default:
              return `<label>${label}<input type="text" ${common}${placeholder}${typeof def === 'string' ? ` value="${escapeAppComponentAttr(def)}"` : ''}></label>`;
          }
        })
        .join('\n');
      return [
        '<div class="ob-card ob-form">',
        component.title ? `<h2>${escapeAppComponentText(component.title)}</h2>` : '',
        component.description ? `<p>${escapeAppComponentText(component.description)}</p>` : '',
        `<form data-ob-tool="${escapeAppComponentAttr(component.tool)}">${fields}<button type="submit">${escapeAppComponentText(component.submitLabel ?? 'Gửi')}</button></form>`,
        '<pre class="ob-result" data-ob-result hidden></pre>',
        '</div>',
      ]
        .filter((part) => part !== '')
        .join('\n');
    }
    case 'list': {
      const items = component.items
        .map(
          (item) =>
            `<li><strong>${escapeAppComponentText(item.title)}</strong>${item.badge ? ` <span class="ob-badge">${escapeAppComponentText(item.badge)}</span>` : ''}${item.description ? `<br><span style="color:var(--ob-muted)">${escapeAppComponentText(item.description)}</span>` : ''}</li>`,
        )
        .join('\n');
      return [
        '<div class="ob-card">',
        component.title ? `<p class="ob-title">${escapeAppComponentText(component.title)}</p>` : '',
        `<ul class="ob-list">${items}</ul>`,
        '</div>',
      ]
        .filter((part) => part !== '')
        .join('\n');
    }
    case 'chart-placeholder': {
      return renderChartPlaceholder(component);
    }
    case 'stack': {
      const cls = component.direction === 'horizontal' ? 'ob-stack-h' : 'ob-stack';
      return `<div class="${cls}">${renderChildren(component.children)}</div>`;
    }
    case 'grid': {
      const cols = component.columns ?? 2;
      return `<div class="ob-grid" style="grid-template-columns:repeat(${cols},1fr)">${renderChildren(component.children)}</div>`;
    }
    case 'html': {
      return component.html;
    }
    default:
      return '';
  }
}

/** Vẽ chart-placeholder thành SVG thuần (bar hoặc line), không cần JS. */
export function renderChartPlaceholder(component: Extract<AppComponent, { type: 'chart-placeholder' }>): string {
  const width = 560;
  const height = 220;
  const padLeft = 44;
  const padBottom = 28;
  const padTop = 12;
  const chartWidth = width - padLeft - 8;
  const chartHeight = height - padTop - padBottom;
  const max = Math.max(...component.values, 1);
  const min = Math.min(0, ...component.values);
  const range = max - min || 1;
  const yFor = (v: number) => padTop + chartHeight - ((v - min) / range) * chartHeight;
  const stepX = chartWidth / component.values.length;
  let body = '';
  if (component.kind === 'bar') {
    const barWidth = Math.max(4, Math.floor(stepX * 0.6));
    body = component.values
      .map((v, i) => {
        const x = padLeft + i * stepX + (stepX - barWidth) / 2;
        const y = yFor(Math.max(v, 0));
        const h = Math.max(1, yFor(0) - y);
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth}" height="${h.toFixed(1)}" fill="#2563eb" rx="2"><title>${escapeAppComponentText(component.labels[i] ?? '')}: ${v}</title></rect>`;
      })
      .join('\n');
  } else {
    const points = component.values
      .map((v, i) => `${(padLeft + i * stepX + stepX / 2).toFixed(1)},${yFor(v).toFixed(1)}`)
      .join(' ');
    const dots = component.values
      .map(
        (v, i) =>
          `<circle cx="${(padLeft + i * stepX + stepX / 2).toFixed(1)}" cy="${yFor(v).toFixed(1)}" r="3.5" fill="#2563eb"><title>${escapeAppComponentText(component.labels[i] ?? '')}: ${v}</title></circle>`,
      )
      .join('\n');
    body = `<polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="2" />\n${dots}`;
  }
  const xLabels = component.labels
    .map(
      (label, i) =>
        `<text x="${(padLeft + i * stepX + stepX / 2).toFixed(1)}" y="${height - 8}" font-size="11" text-anchor="middle" fill="#666666">${escapeAppComponentText(label)}</text>`,
    )
    .join('\n');
  return [
    '<div class="ob-card">',
    component.title ? `<p class="ob-title">${escapeAppComponentText(component.title)}</p>` : '',
    `<svg class="ob-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAppComponentAttr(component.title ?? 'Chart')}">`,
    `<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + chartHeight}" stroke="#dddddd" />`,
    `<line x1="${padLeft}" y1="${padTop + chartHeight}" x2="${width - 8}" y2="${padTop + chartHeight}" stroke="#dddddd" />`,
    `<text x="6" y="${padTop + 10}" font-size="11" fill="#666666">${escapeAppComponentText(String(max))}${component.unit ? ` ${escapeAppComponentText(component.unit)}` : ''}</text>`,
    body,
    xLabels,
    '</svg>',
    '<p style="color:var(--ob-muted);font-size:12px;margin:8px 0 0">Chart placeholder — host vẽ SVG tĩnh từ dữ liệu; app phức tạp dùng escape hatch HTML để vẽ chart tương tác.</p>',
    '</div>',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/** Tuỳ chọn render một danh sách component thành tài liệu HTML đầy đủ. */
export interface RenderAppComponentsOptions {
  title?: string;
  /** Theme host muốn app dùng: light / dark (mặc định light). */
  theme?: 'light' | 'dark';
  /** Có nhúng client shim `ui/` không (mặc định true). */
  includeShim?: boolean;
  /** Có nhúng CSS kit không (mặc định true). */
  includeCss?: boolean;
}

/**
 * Render danh sách component thành tài liệu HTML đầy đủ, sẵn sàng đưa
 * qua `validateAppHtml` + `buildAppFrameConfig`. Ném
 * `AppComponentError` khi danh sách rỗng, quá nhiều component, hoặc
 * có component không hợp lệ.
 */
export function renderAppComponents(
  components: readonly AppComponent[],
  options: RenderAppComponentsOptions = {},
): string {
  if (!Array.isArray(components) || components.length === 0) {
    throw new AppComponentError('Cần ít nhất một component để render app.', 'component-empty');
  }
  if (components.length > APP_COMPONENT_MAX_COUNT) {
    throw new AppComponentError(
      `Quá nhiều component (${components.length}, tối đa ${APP_COMPONENT_MAX_COUNT}).`,
      'component-too-many',
    );
  }
  let total = 0;
  for (const component of components) {
    assertValidAppComponent(component);
    total += countAppComponents(component);
  }
  if (total > APP_COMPONENT_MAX_COUNT) {
    throw new AppComponentError(
      `Quá nhiều component (tổng ${total}, tối đa ${APP_COMPONENT_MAX_COUNT}).`,
      'component-too-many',
    );
  }
  const theme = options.theme === 'dark' ? 'dark' : 'light';
  const title = options.title ?? 'MCP App';
  const body = components.map((c) => renderComponentInner(c)).join('\n');
  const css = options.includeCss === false ? '' : `<style>\n${APP_COMPONENT_KIT_CSS}\n</style>`;
  const shim = options.includeShim === false ? '' : `<script>\n${buildAppClientShim()}\n</script>`;
  return [
    '<!doctype html>',
    `<html lang="en" data-theme="${theme}">`,
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeAppComponentText(title)}</title>`,
    css,
    '</head>',
    '<body>',
    `<div class="ob-stack">${body}</div>`,
    shim,
    '</body></html>',
  ]
    .filter((part) => part !== '')
    .join('\n');
}
