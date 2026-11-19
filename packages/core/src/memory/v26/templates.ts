/**
 * Memory v26 — block templates (v1.41, Doi T1).
 *
 * Y tuong hoc tu Letta (survey v141 muc 2, chi y tuong): block
 * chuan `human` (biet ve user) / `persona` (biet ve chinh agent)
 * + custom block cho task/project. Template dinh nghia cau truc
 * block de cac bot dung chung 1 dinh dang — doc block cua nhau
 * khong phai doan.
 *
 * Template co san (built-in):
 *  - human:   Ten / So thich / Cong viec / Muc tieu / Luu y.
 *  - persona: Vai tro / Giong dieu / Quy tac / Gioi han.
 *  - task:    Muc tieu / Buoc hien tai / Ket qua / Chan tro.
 *  - project: Tong quan / Muc tieu / Tien do / Quyet dinh /
 *             Rui ro.
 * User co the dang ky template tu tao (kind bat ky) — kiem tra
 * id hop le, khong ghi de template built-in.
 *
 * Khoi tao block tu template: thay the placeholder `{{field}}`
 * trong defaultValue bang gia tri user truyen (neu co), kiem tra
 * cac truong bat buoc deu co mat trong value cuoi.
 *
 * Chay 100% local, khong goi model/mang.
 */
import {
  errV26,
  isValidTemplateIdV26,
  isoAtV26,
  okV26,
  type V26BlockKind,
  type V26BlockTemplate,
  type V26Result,
  type V26TemplateInput,
} from './types';

/** Gia tri mac dinh cua template `human`. */
export const V26_HUMAN_TEMPLATE_VALUE = [
  '## Ten',
  '{{Ten}}',
  '',
  '## So thich',
  '{{So thich}}',
  '',
  '## Cong viec',
  '{{Cong viec}}',
  '',
  '## Muc tieu',
  '{{Muc tieu}}',
  '',
  '## Luu y',
  '{{Luu y}}',
  '',
].join('\n');

/** Gia tri mac dinh cua template `persona`. */
export const V26_PERSONA_TEMPLATE_VALUE = [
  '## Vai tro',
  '{{Vai tro}}',
  '',
  '## Giong dieu',
  '{{Giong dieu}}',
  '',
  '## Quy tac',
  '{{Quy tac}}',
  '',
  '## Gioi han',
  '{{Gioi han}}',
  '',
].join('\n');

/** Gia tri mac dinh cua template `task`. */
export const V26_TASK_TEMPLATE_VALUE = [
  '## Muc tieu',
  '{{Muc tieu}}',
  '',
  '## Buoc hien tai',
  '{{Buoc hien tai}}',
  '',
  '## Ket qua',
  '{{Ket qua}}',
  '',
  '## Chan tro',
  '{{Chan tro}}',
  '',
].join('\n');

/** Gia tri mac dinh cua template `project`. */
export const V26_PROJECT_TEMPLATE_VALUE = [
  '## Tong quan',
  '{{Tong quan}}',
  '',
  '## Muc tieu',
  '{{Muc tieu}}',
  '',
  '## Tien do',
  '{{Tien do}}',
  '',
  '## Quyet dinh',
  '{{Quyet dinh}}',
  '',
  '## Rui ro',
  '{{Rui ro}}',
  '',
].join('\n');

/** Tao 4 template built-in. */
export function builtinTemplatesV26(nowMs: number = Date.now()): V26BlockTemplate[] {
  const at = isoAtV26(nowMs);
  return [
    {
      id: 'human',
      kind: 'human',
      name: 'Human — biet ve user',
      description: 'Block chuan ve user: ten, so thich, cong viec, muc tieu, luu y.',
      requiredFields: ['Ten', 'Muc tieu'],
      optionalFields: ['So thich', 'Cong viec', 'Luu y'],
      defaultValue: V26_HUMAN_TEMPLATE_VALUE,
      suggestedBudgetTokens: 2000,
      builtin: true,
      createdAt: at,
    },
    {
      id: 'persona',
      kind: 'persona',
      name: 'Persona — biet ve agent',
      description: 'Block chuan ve chinh agent: vai tro, giong dieu, quy tac, gioi han.',
      requiredFields: ['Vai tro', 'Giong dieu'],
      optionalFields: ['Quy tac', 'Gioi han'],
      defaultValue: V26_PERSONA_TEMPLATE_VALUE,
      suggestedBudgetTokens: 1500,
      builtin: true,
      createdAt: at,
    },
    {
      id: 'task',
      kind: 'task',
      name: 'Task — nhiem vu',
      description: 'Block cho 1 nhiem vu: muc tieu, buoc hien tai, ket qua, chan tro.',
      requiredFields: ['Muc tieu', 'Buoc hien tai'],
      optionalFields: ['Ket qua', 'Chan tro'],
      defaultValue: V26_TASK_TEMPLATE_VALUE,
      suggestedBudgetTokens: 2000,
      builtin: true,
      createdAt: at,
    },
    {
      id: 'project',
      kind: 'project',
      name: 'Project — du an',
      description: 'Block cho 1 du an: tong quan, muc tieu, tien do, quyet dinh, rui ro.',
      requiredFields: ['Tong quan', 'Muc tieu', 'Tien do'],
      optionalFields: ['Quyet dinh', 'Rui ro'],
      defaultValue: V26_PROJECT_TEMPLATE_VALUE,
      suggestedBudgetTokens: 4000,
      builtin: true,
      createdAt: at,
    },
  ];
}

/** Registry template. */
export class V26TemplateRegistry {
  private readonly templates = new Map<string, V26BlockTemplate>();

  constructor(opts: { includeBuiltin?: boolean; nowMs?: number } = {}) {
    if (opts.includeBuiltin !== false) {
      for (const t of builtinTemplatesV26(opts.nowMs ?? Date.now())) {
        this.templates.set(t.id, t);
      }
    }
  }

  get size(): number {
    return this.templates.size;
  }

  get(id: string): V26BlockTemplate | undefined {
    return this.templates.get(id.trim().toLowerCase());
  }

  /** Liet ke template (built-in truoc, theo ten). */
  list(filter: { kind?: V26BlockKind; builtin?: boolean } = {}): V26BlockTemplate[] {
    const out: V26BlockTemplate[] = [];
    for (const t of this.templates.values()) {
      if (filter.kind !== undefined && t.kind !== filter.kind) continue;
      if (filter.builtin !== undefined && t.builtin !== filter.builtin) continue;
      out.push(t);
    }
    out.sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  /**
   * Dang ky template tu tao. Khong ghi de template built-in;
   * id phai hop le; defaultValue khong duoc rong.
   */
  register(input: V26TemplateInput, opts: { nowMs?: number } = {}): V26Result<V26BlockTemplate> {
    const id = input.id.trim().toLowerCase();
    if (!isValidTemplateIdV26(id)) {
      return errV26(`Id template "${input.id}" khong hop le (a-z, 0-9, _-, 1..64 ky tu).`);
    }
    const existing = this.templates.get(id);
    if (existing && existing.builtin) {
      return errV26(`Template "${id}" la built-in, khong duoc ghi de.`);
    }
    if (existing) {
      return errV26(`Da co template "${id}" (tu tao) — xoa truoc khi dang ky lai.`);
    }
    if (!input.name || !input.name.trim()) return errV26('name template khong duoc rong.');
    if (!input.defaultValue || !input.defaultValue.trim()) {
      return errV26('defaultValue template khong duoc rong.');
    }
    const budget = input.suggestedBudgetTokens ?? 0;
    if (!Number.isInteger(budget) || budget < 0 || budget > 1000000) {
      return errV26('suggestedBudgetTokens phai la so nguyen 0..1000000.');
    }
    const template: V26BlockTemplate = {
      id,
      kind: input.kind,
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      requiredFields: [...(input.requiredFields ?? [])].map((f) => f.trim()).filter((f) => f.length > 0),
      optionalFields: [...(input.optionalFields ?? [])].map((f) => f.trim()).filter((f) => f.length > 0),
      defaultValue: input.defaultValue,
      suggestedBudgetTokens: budget,
      builtin: false,
      createdAt: isoAtV26(opts.nowMs ?? Date.now()),
    };
    this.templates.set(id, template);
    return okV26(template);
  }

  /** Xoa template tu tao (built-in khong xoa duoc). */
  remove(id: string): V26Result<boolean> {
    const norm = id.trim().toLowerCase();
    const existing = this.templates.get(norm);
    if (!existing) return errV26(`Khong co template "${id}".`);
    if (existing.builtin) return errV26(`Template "${id}" la built-in, khong xoa duoc.`);
    this.templates.delete(norm);
    return okV26(true);
  }

  /**
   * Khoi tao value tu template: thay placeholder `{{Field}}`
   * bang gia tri truyen vao; truong khong truyen thi giu
   * placeholder mo ta trong defaultValue.
   */
  instantiate(
    templateId: string,
    values: Record<string, string> = {},
  ): V26Result<{ value: string; template: V26BlockTemplate; missingRequired: string[] }> {
    const template = this.get(templateId);
    if (!template) return errV26(`Khong co template "${templateId}".`);
    let value = template.defaultValue;
    for (const [key, val] of Object.entries(values)) {
      const placeholder = new RegExp(`\\{\\{\\s*${escapeRegExpV26(key.trim())}\\s*\\}\\}`, 'g');
      value = value.replace(placeholder, val);
    }
    const missingRequired = checkRequiredFieldsV26(value, template.requiredFields);
    return okV26({ value, template, missingRequired });
  }

  toJSON(): V26BlockTemplate[] {
    return [...this.templates.values()];
  }

  static fromJSON(data: unknown): V26TemplateRegistry {
    const registry = new V26TemplateRegistry({ includeBuiltin: false });
    if (!Array.isArray(data)) {
      for (const t of builtinTemplatesV26()) registry.templates.set(t.id, t);
      return registry;
    }
    let hasBuiltin = false;
    for (const raw of data as V26BlockTemplate[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      if (raw.builtin) hasBuiltin = true;
      registry.templates.set(raw.id, { ...raw });
    }
    if (!hasBuiltin) {
      for (const t of builtinTemplatesV26()) {
        if (!registry.templates.has(t.id)) registry.templates.set(t.id, t);
      }
    }
    return registry;
  }
}

/**
 * Kiem tra cac truong bat buoc co mat trong value khong.
 * 1 truong duoc tinh la "co mat" khi value chua heading
 * `## <field>` (khong phan biet hoa/thuong) — khong kiem tra
 * noi dung duoi heading co duoc dien hay chua.
 */
export function checkRequiredFieldsV26(value: string, requiredFields: string[]): string[] {
  const missing: string[] = [];
  const lower = value.toLowerCase();
  for (const field of requiredFields) {
    const heading = `## ${field.trim().toLowerCase()}`;
    if (!lower.includes(heading)) missing.push(field);
  }
  return missing;
}

/**
 * Kiem tra value cua block co du truong bat buoc cua template
 * khong — tra loi neu thieu (de store canh bao khi tao block
 * tu template ma value bi cat xe).
 */
export function validateBlockAgainstTemplateV26(
  value: string,
  template: V26BlockTemplate,
): V26Result<{ missing: string[] }> {
  const missing = checkRequiredFieldsV26(value, template.requiredFields);
  if (missing.length > 0) {
    return errV26(
      `Block thieu truong bat buoc cua template "${template.id}": ${missing.join(', ')}.`,
    );
  }
  return okV26({ missing: [] });
}

function escapeRegExpV26(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
