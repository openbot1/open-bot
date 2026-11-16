/**
 * MCP Apps v2 — component kit mở rộng (v1.14, Đội T2).
 *
 * Component kit v1.13 (`appsComponents.ts`) đã có card / table / metric /
 * form / list / chart-placeholder / stack / grid / html — đủ cho app
 * hiển thị, nhưng thiếu các mảnh TƯƠNG TÁC mà app thật cần: nút bấm,
 * ô nhập, select, toggle, thanh tiến độ, badge, modal, toast, tabs.
 * Module này bổ sung các component đó, dùng chung hàm escape + giới hạn
 * của kit v1.13 (không render HTML tay ngoài kit):
 *
 *   - Mỗi component: `validateAppComponentV2()` kiểm tra shape + giới
 *     hạn (text, số lượng, độ sâu) rồi `renderAppComponentV2()` ra HTML
 *     đã escape — mọi text user nhập đều qua `escapeAppComponentText`.
 *   - `APP_COMPONENT_V2_CSS`: CSS dùng chung cho cả kit (nút, input,
 *     modal, toast, tabs...) để app không phải tự viết style.
 *   - Component `modal` / `toast` render kèm shim JS tối thiểu (đóng
 *     modal, tự ẩn toast) — không gọi tool, không chạm parent.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import {
  APP_COMPONENT_MAX_COUNT,
  APP_COMPONENT_MAX_TEXT_CHARS,
  escapeAppComponentAttr,
  escapeAppComponentText,
} from './appsComponents';

/** Số tab tối đa trong một tabs. */
export const APP_COMPONENT_V2_MAX_TABS = 8;
/** Số option tối đa trong một select. */
export const APP_COMPONENT_V2_MAX_OPTIONS = 50;
/** Số toast tối đa render cùng lúc. */
export const APP_COMPONENT_V2_MAX_TOASTS = 5;

export class AppComponentV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppComponentV2Error';
  }
}

/** Một action khi bấm nút / chọn tab (gọi tool qua bridge của host). */
export interface AppComponentV2Action {
  label: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

/** Component kit v2. */
export type AppComponentV2 =
  | { type: 'button'; label: string; action: AppComponentV2Action; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean }
  | { type: 'textInput'; name: string; label: string; value?: string; placeholder?: string; inputType?: 'text' | 'number' | 'password' | 'search'; required?: boolean }
  | { type: 'select'; name: string; label: string; options: { value: string; label: string }[]; selected?: string }
  | { type: 'toggle'; name: string; label: string; checked?: boolean; description?: string }
  | { type: 'progressBar'; label: string; value: number; max?: number; showPercent?: boolean }
  | { type: 'badge'; text: string; tone?: 'info' | 'success' | 'warning' | 'danger' }
  | { type: 'modal'; id: string; title: string; body: string; actions?: AppComponentV2Action[] }
  | { type: 'toast'; message: string; tone?: 'info' | 'success' | 'warning' | 'danger'; durationMs?: number }
  | { type: 'tabs'; tabs: { id: string; label: string; content: string }[]; activeTab?: string };

/** Mọi type component v2. */
export const APP_COMPONENT_V2_TYPES = [
  'button',
  'textInput',
  'select',
  'toggle',
  'progressBar',
  'badge',
  'modal',
  'toast',
  'tabs',
] as const;

/** CSS dùng chung cho kit v2 (app nhúng qua bundler hoặc shim). */
export const APP_COMPONENT_V2_CSS = [
  '.ob-btn{padding:8px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:14px}',
  '.ob-btn-primary{background:#2563eb;color:#fff;border-color:#2563eb}',
  '.ob-btn-danger{background:#dc2626;color:#fff;border-color:#dc2626}',
  '.ob-btn[disabled]{opacity:.5;cursor:not-allowed}',
  '.ob-field{display:flex;flex-direction:column;gap:4px;margin:8px 0;font-size:14px}',
  '.ob-field input,.ob-field select{padding:8px;border-radius:8px;border:1px solid #cbd5e1;font-size:14px}',
  '.ob-toggle{display:flex;gap:8px;align-items:center;margin:8px 0;font-size:14px}',
  '.ob-progress{height:10px;background:#e2e8f0;border-radius:999px;overflow:hidden}',
  '.ob-progress>div{height:100%;background:#2563eb}',
  '.ob-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#e2e8f0}',
  '.ob-badge-success{background:#dcfce7}.ob-badge-warning{background:#fef9c3}.ob-badge-danger{background:#fee2e2}',
  '.ob-modal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)}',
  '.ob-modal-card{background:#fff;border-radius:12px;padding:20px;max-width:480px;width:90%}',
  '.ob-toast{padding:10px 14px;border-radius:8px;background:#1e293b;color:#fff;margin:6px 0;font-size:14px}',
  '.ob-tabs{display:flex;gap:4px;border-bottom:1px solid #e2e8f0;margin-bottom:12px}',
  '.ob-tab{padding:8px 12px;border:none;background:none;cursor:pointer;font-size:14px}',
  '.ob-tab-active{border-bottom:2px solid #2563eb;font-weight:600}',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function actionJson(action: AppComponentV2Action): string {
  return escapeAppComponentAttr(
    JSON.stringify({ tool: action.tool, arguments: action.arguments ?? {} }),
  );
}

/**
 * Kiểm tra một component v2, trả danh sách lỗi (rỗng = hợp lệ).
 * Giới hạn: text <= 2000 ký tự (khớp kit v1.13), tabs <= 8, options <= 50.
 */
export function validateAppComponentV2(component: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(component)) return ['component: phải là object'];
  const type = component['type'];
  if (typeof type !== 'string' || !(APP_COMPONENT_V2_TYPES as readonly string[]).includes(type)) {
    return [`component.type: không hỗ trợ: ${JSON.stringify(type)}`];
  }
  const checkText = (value: unknown, field: string): void => {
    if (typeof value !== 'string') errors.push(`${field}: phải là chuỗi`);
    else if (value.length > APP_COMPONENT_MAX_TEXT_CHARS) {
      errors.push(`${field}: tối đa ${APP_COMPONENT_MAX_TEXT_CHARS} ký tự`);
    }
  };
  const checkAction = (value: unknown, field: string): void => {
    if (!isRecord(value)) {
      errors.push(`${field}: phải là object`);
      return;
    }
    if (!asText(value['label'])) errors.push(`${field}.label: bắt buộc`);
    if (!asText(value['tool'])) errors.push(`${field}.tool: bắt buộc`);
  };
  switch (type) {
    case 'button': {
      if (!asText(component['label'])) errors.push('label: bắt buộc');
      else checkText(component['label'], 'label');
      checkAction(component['action'], 'action');
      if (
        component['variant'] !== undefined &&
        !['primary', 'secondary', 'danger'].includes(component['variant'] as string)
      ) {
        errors.push('variant: phải là primary | secondary | danger');
      }
      break;
    }
    case 'textInput': {
      if (!asText(component['name'])) errors.push('name: bắt buộc');
      if (!asText(component['label'])) errors.push('label: bắt buộc');
      if (component['inputType'] !== undefined) {
        const t = component['inputType'];
        if (t !== 'text' && t !== 'number' && t !== 'password' && t !== 'search') {
          errors.push('inputType: phải là text | number | password | search');
        }
      }
      if (component['value'] !== undefined) checkText(component['value'], 'value');
      if (component['placeholder'] !== undefined) checkText(component['placeholder'], 'placeholder');
      break;
    }
    case 'select': {
      if (!asText(component['name'])) errors.push('name: bắt buộc');
      if (!asText(component['label'])) errors.push('label: bắt buộc');
      if (!Array.isArray(component['options']) || component['options'].length === 0) {
        errors.push('options: cần ít nhất 1 option');
      } else {
        if (component['options'].length > APP_COMPONENT_V2_MAX_OPTIONS) {
          errors.push(`options: tối đa ${APP_COMPONENT_V2_MAX_OPTIONS} option`);
        }
        for (const opt of component['options']) {
          if (!isRecord(opt) || !asText(opt['value']) || !asText(opt['label'])) {
            errors.push('options: mỗi option cần value + label');
            break;
          }
        }
        if (
          component['selected'] !== undefined &&
          !(component['options'] as unknown[]).some(
            (o) => isRecord(o) && o['value'] === component['selected'],
          )
        ) {
          errors.push('selected: phải là một option có sẵn');
        }
      }
      break;
    }
    case 'toggle': {
      if (!asText(component['name'])) errors.push('name: bắt buộc');
      if (!asText(component['label'])) errors.push('label: bắt buộc');
      if (component['description'] !== undefined) checkText(component['description'], 'description');
      break;
    }
    case 'progressBar': {
      if (!asText(component['label'])) errors.push('label: bắt buộc');
      const value = component['value'];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push('value: phải là số >= 0');
      }
      const max = component['max'];
      if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max) || max <= 0)) {
        errors.push('max: phải là số > 0');
      }
      if (typeof value === 'number' && typeof max === 'number' && value > max) {
        errors.push('value: không được vượt max');
      }
      break;
    }
    case 'badge': {
      if (!asText(component['text'])) errors.push('text: bắt buộc');
      else checkText(component['text'], 'text');
      if (
        component['tone'] !== undefined &&
        !['info', 'success', 'warning', 'danger'].includes(component['tone'] as string)
      ) {
        errors.push('tone: phải là info | success | warning | danger');
      }
      break;
    }
    case 'modal': {
      if (!asText(component['id'])) errors.push('id: bắt buộc');
      if (!asText(component['title'])) errors.push('title: bắt buộc');
      if (typeof component['body'] !== 'string') errors.push('body: phải là chuỗi');
      else checkText(component['body'], 'body');
      if (Array.isArray(component['actions'])) {
        if (component['actions'].length > APP_COMPONENT_MAX_COUNT) {
          errors.push(`actions: tối đa ${APP_COMPONENT_MAX_COUNT}`);
        }
        component['actions'].forEach((a, i) => checkAction(a, `actions[${i}]`));
      }
      break;
    }
    case 'toast': {
      if (!asText(component['message'])) errors.push('message: bắt buộc');
      else checkText(component['message'], 'message');
      if (
        component['tone'] !== undefined &&
        !['info', 'success', 'warning', 'danger'].includes(component['tone'] as string)
      ) {
        errors.push('tone: phải là info | success | warning | danger');
      }
      const duration = component['durationMs'];
      if (duration !== undefined && (typeof duration !== 'number' || duration < 0 || duration > 60_000)) {
        errors.push('durationMs: phải là số 0..60000');
      }
      break;
    }
    case 'tabs': {
      if (!Array.isArray(component['tabs']) || component['tabs'].length === 0) {
        errors.push('tabs: cần ít nhất 1 tab');
      } else {
        if (component['tabs'].length > APP_COMPONENT_V2_MAX_TABS) {
          errors.push(`tabs: tối đa ${APP_COMPONENT_V2_MAX_TABS} tab`);
        }
        for (const tab of component['tabs']) {
          if (!isRecord(tab) || !asText(tab['id']) || !asText(tab['label'])) {
            errors.push('tabs: mỗi tab cần id + label');
            break;
          }
          if (typeof tab['content'] !== 'string') {
            errors.push('tabs: content của mỗi tab phải là chuỗi');
            break;
          }
        }
        if (
          component['activeTab'] !== undefined &&
          !(component['tabs'] as unknown[]).some(
            (t) => isRecord(t) && t['id'] === component['activeTab'],
          )
        ) {
          errors.push('activeTab: phải là id của một tab có sẵn');
        }
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

/** Ném `AppComponentV2Error` khi component không hợp lệ. */
export function assertValidAppComponentV2(component: unknown): asserts component is AppComponentV2 {
  const errors = validateAppComponentV2(component);
  if (errors.length > 0) {
    throw new AppComponentV2Error(`Component v2 không hợp lệ: ${errors.join('; ')}`);
  }
}

/** Đếm component v2 trong một danh sách (để giới hạn tổng số). */
export function countAppComponentsV2(components: readonly AppComponentV2[]): number {
  return components.length;
}

function renderActionButton(action: AppComponentV2Action, variant: string): string {
  const cls = variant === 'primary' ? 'ob-btn ob-btn-primary' : variant === 'danger' ? 'ob-btn ob-btn-danger' : 'ob-btn';
  return `<button class="${cls}" data-tool-call="${actionJson(action)}">${escapeAppComponentText(action.label)}</button>`;
}

/** Render một component v2 thành HTML đã escape. Ném khi không hợp lệ. */
export function renderAppComponentV2(component: AppComponentV2): string {
  assertValidAppComponentV2(component);
  switch (component.type) {
    case 'button': {
      const variant = component.variant ?? 'secondary';
      const disabled = component.disabled === true ? ' disabled' : '';
      const cls =
        variant === 'primary'
          ? 'ob-btn ob-btn-primary'
          : variant === 'danger'
            ? 'ob-btn ob-btn-danger'
            : 'ob-btn';
      return `<button class="${cls}" data-tool-call="${actionJson(component.action)}"${disabled}>${escapeAppComponentText(component.label)}</button>`;
    }
    case 'textInput': {
      const inputType = component.inputType ?? 'text';
      return `<label class="ob-field">${escapeAppComponentText(component.label)}${component.required === true ? ' *' : ''}<input type="${inputType}" name="${escapeAppComponentAttr(component.name)}"${component.value !== undefined ? ` value="${escapeAppComponentAttr(component.value)}"` : ''}${component.placeholder ? ` placeholder="${escapeAppComponentAttr(component.placeholder)}"` : ''}${component.required === true ? ' required' : ''}></label>`;
    }
    case 'select': {
      const options = component.options
        .map(
          (o) =>
            `<option value="${escapeAppComponentAttr(o.value)}"${o.value === component.selected ? ' selected' : ''}>${escapeAppComponentText(o.label)}</option>`,
        )
        .join('');
      return `<label class="ob-field">${escapeAppComponentText(component.label)}<select name="${escapeAppComponentAttr(component.name)}">${options}</select></label>`;
    }
    case 'toggle': {
      return `<label class="ob-toggle"><input type="checkbox" name="${escapeAppComponentAttr(component.name)}"${component.checked === true ? ' checked' : ''}>${escapeAppComponentText(component.label)}${component.description ? ` <span>${escapeAppComponentText(component.description)}</span>` : ''}</label>`;
    }
    case 'progressBar': {
      const max = component.max ?? 100;
      const pct = Math.max(0, Math.min(100, Math.round((component.value / max) * 100)));
      return `<div class="ob-field"><span>${escapeAppComponentText(component.label)}${component.showPercent === true ? ` — ${pct}%` : ''}</span><div class="ob-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div></div>`;
    }
    case 'badge': {
      const tone = component.tone ?? 'info';
      return `<span class="ob-badge${tone === 'info' ? '' : ` ob-badge-${tone}`}">${escapeAppComponentText(component.text)}</span>`;
    }
    case 'modal': {
      const actions = (component.actions ?? [])
        .map((a) => renderActionButton(a, 'secondary'))
        .join('');
      return `<div class="ob-modal" id="${escapeAppComponentAttr(component.id)}"><div class="ob-modal-card"><h3>${escapeAppComponentText(component.title)}</h3><p>${escapeAppComponentText(component.body)}</p><div>${actions}<button class="ob-btn" onclick="document.getElementById('${escapeAppComponentAttr(component.id)}').remove()">Đóng</button></div></div></div>`;
    }
    case 'toast': {
      const tone = component.tone ?? 'info';
      const duration = component.durationMs ?? 5000;
      return `<div class="ob-toast ob-toast-${tone}" data-duration-ms="${duration}">${escapeAppComponentText(component.message)}</div>`;
    }
    case 'tabs': {
      const active = component.activeTab ?? component.tabs[0].id;
      const buttons = component.tabs
        .map(
          (t) =>
            `<button class="ob-tab${t.id === active ? ' ob-tab-active' : ''}" data-tab="${escapeAppComponentAttr(t.id)}">${escapeAppComponentText(t.label)}</button>`,
        )
        .join('');
      const activeTab = component.tabs.find((t) => t.id === active) ?? component.tabs[0];
      return `<div><div class="ob-tabs">${buttons}</div><div data-tab-panel="${escapeAppComponentAttr(activeTab.id)}">${escapeAppComponentText(activeTab.content)}</div></div>`;
    }
    default:
      return '';
  }
}

/**
 * Render danh sách component v2 thành HTML (kèm `<style>` kit). Ném khi
 * danh sách vượt `APP_COMPONENT_MAX_COUNT` hoặc có component lỗi.
 */
export function renderAppComponentsV2(
  components: readonly AppComponentV2[],
  options: { includeCss?: boolean } = {},
): string {
  if (components.length > APP_COMPONENT_MAX_COUNT) {
    throw new AppComponentV2Error(
      `Tối đa ${APP_COMPONENT_MAX_COUNT} component v2 mỗi lần render, nhận ${components.length}`,
    );
  }
  const body = components.map((c) => renderAppComponentV2(c)).join('\n');
  const css = options.includeCss === false ? '' : `<style>\n${APP_COMPONENT_V2_CSS}\n</style>\n`;
  return `${css}${body}`;
}
