/**
 * Memory v13 — block templates theo task (v1.14, Doi T1).
 *
 * Y tuong hoc tu Letta (custom block cho task/project state: block
 * khong phai trang giay trang ma co cau truc san theo viec dang lam)
 * — tu thiet ke lai hoan toan cho open-bot, KHONG copy code/text/tai
 * san cua bat ky repo nao.
 *
 * Moi template la mot khuon co san: label goi y, mo ta, gioi han ky tu,
 * noi dung khoi tao (dang checklist tieu de muc, de agent/user dien
 * vao), va ACL goi y (xem acl.ts). `instantiateBlockTemplate` tao
 * block that qua `MemoryBlockStore.create` nen ke thua toan bo luat
 * cua store (label duy nhat, gioi han ky tu, audit, snapshot lich su).
 */

import type { MemoryBlock, MemoryBlockStore } from '../blocks';
import type { V13BlockAclLevel } from './acl';

/** Mot template block theo task. */
export interface V13BlockTemplate {
  id: string;
  /** Nhom task template phuc vu (hien trong UI de loc). */
  kind: string;
  /** Label goi y khi tao block (user co the doi). */
  label: string;
  description: string;
  charLimit: number;
  /** Noi dung khoi tao — cac muc de trong, agent/user dien dan. */
  defaultContent: string;
  /** ACL goi y cho block tao tu template nay. */
  suggestedAcl: V13BlockAclLevel;
  /** Cac muc trong template (de UI hien checklist). */
  sections: string[];
}

/** Loi template — message tieng Viet. */
export class V13BlockTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V13BlockTemplateError';
  }
}

export const V13_BLOCK_TEMPLATES: V13BlockTemplate[] = [
  {
    id: 'coding',
    kind: 'coding',
    label: 'coding-notes',
    description: 'Ghi chu lap trinh: stack, quy uoc, loi hay gap cua du an dang lam.',
    charLimit: 4000,
    suggestedAcl: 'open',
    sections: ['Stack', 'Quy uoc code', 'Loi hay gap', 'Dang lam do'],
    defaultContent: [
      '# Coding notes',
      '',
      '## Stack',
      '- Ngon ngu / framework: ',
      '- Lenh chay: ',
      '- Lenh test: ',
      '',
      '## Quy uoc code',
      '- ',
      '',
      '## Loi hay gap',
      '- ',
      '',
      '## Dang lam do',
      '- ',
    ].join('\n'),
  },
  {
    id: 'research',
    kind: 'research',
    label: 'research-notes',
    description: 'Ghi chu nghien cuu: cau hoi, nguon, ket luan tam thoi va viec can kiem chung.',
    charLimit: 4000,
    suggestedAcl: 'open',
    sections: ['Cau hoi', 'Nguon', 'Ket luan tam thoi', 'Can kiem chung'],
    defaultContent: [
      '# Research notes',
      '',
      '## Cau hoi dang tra loi',
      '- ',
      '',
      '## Nguon da doc',
      '- ',
      '',
      '## Ket luan tam thoi',
      '- ',
      '',
      '## Can kiem chung',
      '- ',
    ].join('\n'),
  },
  {
    id: 'daily',
    kind: 'daily',
    label: 'daily-log',
    description: 'Nhat ky ngay: viec lam xong, viec dang do, cam nhan nhanh.',
    charLimit: 3000,
    suggestedAcl: 'open',
    sections: ['Hom nay lam xong', 'Dang do', 'Ngay mai', 'Ghi chu'],
    defaultContent: [
      '# Daily log',
      '',
      '## Hom nay lam xong',
      '- ',
      '',
      '## Dang do',
      '- ',
      '',
      '## Ngay mai',
      '- ',
      '',
      '## Ghi chu',
      '- ',
    ].join('\n'),
  },
  {
    id: 'planning',
    kind: 'planning',
    label: 'plan',
    description: 'Ke hoach: muc tieu, cac buoc, tieu chi xong, rui ro.',
    charLimit: 4000,
    suggestedAcl: 'open',
    sections: ['Muc tieu', 'Cac buoc', 'Tieu chi xong', 'Rui ro'],
    defaultContent: [
      '# Ke hoach',
      '',
      '## Muc tieu',
      '- ',
      '',
      '## Cac buoc',
      '1. ',
      '2. ',
      '',
      '## Tieu chi xong',
      '- ',
      '',
      '## Rui ro',
      '- ',
    ].join('\n'),
  },
  {
    id: 'project',
    kind: 'project',
    label: 'project-state',
    description: 'Trang thai du an: tong quan, tien do, quyet dinh da chot, viec mo.',
    charLimit: 5000,
    suggestedAcl: 'open',
    sections: ['Tong quan', 'Tien do', 'Quyet dinh da chot', 'Viec mo'],
    defaultContent: [
      '# Project state',
      '',
      '## Tong quan',
      '- ',
      '',
      '## Tien do',
      '- ',
      '',
      '## Quyet dinh da chot',
      '- ',
      '',
      '## Viec mo',
      '- ',
    ].join('\n'),
  },
  {
    id: 'learning',
    kind: 'learning',
    label: 'learning-notes',
    description: 'Ghi chu hoc tap: khai niem moi, vi du, cau hoi chua hieu.',
    charLimit: 4000,
    suggestedAcl: 'open',
    sections: ['Khai niem moi', 'Vi du', 'Chua hieu', 'Can on lai'],
    defaultContent: [
      '# Learning notes',
      '',
      '## Khai niem moi',
      '- ',
      '',
      '## Vi du',
      '- ',
      '',
      '## Chua hieu',
      '- ',
      '',
      '## Can on lai',
      '- ',
    ].join('\n'),
  },
  {
    id: 'health',
    kind: 'health',
    label: 'health-notes',
    description: 'Ghi chu suc khoe ca nhan — mac dinh SENSITIVE: khong vao prompt/log.',
    charLimit: 3000,
    suggestedAcl: 'sensitive',
    sections: ['The trang', 'Thoi quen', 'Can chu y'],
    defaultContent: [
      '# Health notes',
      '',
      '## The trang hien tai',
      '- ',
      '',
      '## Thoi quen',
      '- ',
      '',
      '## Can chu y',
      '- ',
    ].join('\n'),
  },
  {
    id: 'travel',
    kind: 'travel',
    label: 'travel-plan',
    description: 'Ke hoach di lai: diem den, lich trinh, ngan sach, giay to can chuan bi.',
    charLimit: 4000,
    suggestedAcl: 'open',
    sections: ['Diem den', 'Lich trinh', 'Ngan sach', 'Giay to'],
    defaultContent: [
      '# Travel plan',
      '',
      '## Diem den',
      '- ',
      '',
      '## Lich trinh',
      '- ',
      '',
      '## Ngan sach',
      '- ',
      '',
      '## Giay to can chuan bi',
      '- ',
    ].join('\n'),
  },
];

/** Ban sao cua toan bo template (de UI liet ke). */
export function listBlockTemplates(): V13BlockTemplate[] {
  return V13_BLOCK_TEMPLATES.map((t) => ({ ...t, sections: [...t.sections] }));
}

/** Tim template theo id (null khi khong co). */
export function getBlockTemplate(id: string): V13BlockTemplate | null {
  const found = V13_BLOCK_TEMPLATES.find((t) => t.id === (id ?? '').trim().toLowerCase());
  return found ? { ...found, sections: [...found.sections] } : null;
}

/** Template theo kind (vd `coding`); tra ve template dau tien khop. */
export function findTemplateByKind(kind: string): V13BlockTemplate | null {
  const found = V13_BLOCK_TEMPLATES.find((t) => t.kind === (kind ?? '').trim().toLowerCase());
  return found ? { ...found, sections: [...found.sections] } : null;
}

export interface V13InstantiateTemplateOptions {
  /** Label rieng (mac dinh lay label goi y cua template). */
  label?: string;
  /** Ghi de mo ta mac dinh. */
  description?: string;
  /** Noi dung khoi tao rieng (mac dinh dung defaultContent). */
  content?: string;
  /** Ghi de gioi han ky tu. */
  charLimit?: number;
  actor?: string;
  createdByBotId?: string;
  /** Attach block moi vao bot ngay khi tao. */
  attachBotId?: string;
  /** Ghi ACL goi y vao kho ACL (can truyen aclStore). */
  aclStore?: { set: (blockId: string, level: V13BlockAclLevel, actor: string) => void };
}

/**
 * Tao block that tu mot template. Label trung (da co block cung
 * label) -> throw giong `store.create` (khong ghi de len).
 */
export function instantiateBlockTemplate(
  store: MemoryBlockStore,
  templateId: string,
  opts: V13InstantiateTemplateOptions = {},
): MemoryBlock {
  const template = getBlockTemplate(templateId);
  if (!template) {
    throw new V13BlockTemplateError(`Khong co block template "${templateId}".`);
  }
  const block = store.create(
    {
      label: opts.label ?? template.label,
      description: opts.description ?? template.description,
      content: opts.content ?? template.defaultContent,
      charLimit: opts.charLimit ?? template.charLimit,
      createdByBotId: opts.createdByBotId ?? '',
    },
    opts.actor ?? 'user',
  );
  if (opts.attachBotId) {
    store.attach(opts.attachBotId, block.id, opts.actor ?? 'user');
  }
  if (opts.aclStore && template.suggestedAcl !== 'open') {
    opts.aclStore.set(block.id, template.suggestedAcl, opts.actor ?? 'user');
  }
  return block;
}

/**
 * Kiem tra mot block co dung cau truc cua template khong (cac tieu de
 * muc van con). Dung de UI nhac user dien cac muc dang trong.
 * Tra ve danh sach muc con thieu (rong = du muc).
 */
export function missingTemplateSections(block: MemoryBlock, templateId: string): string[] {
  const template = getBlockTemplate(templateId);
  if (!template) return [];
  return template.sections.filter(
    (section) => !block.content.includes(`## ${section}`),
  );
}
