/**
 * Memory v11 — block kinds (v1.11, Doi T1).
 *
 * Y tuong hoc tu Letta/MemGPT (core memory co cac block co ten:
 * `human`, `persona`, `task`, `project`, `safety` — bien dich thang
 * vao system prompt duoi dang `<memory_blocks>`, agent tu sua bang
 * tool), viet lai hoan toan cho open-bot tren MemoryBlockStore co san
 * (v0.96) + CoreMemoryManager v9 — KHONG viet lai store, chi them lop
 * KIEU (kind) len tren:
 *
 *  - 5 kind he thong: `human` (su that ve user), `persona` (tinh
 *    cach / cach hanh xu cua bot), `task` (nhiem vu dang lam),
 *    `project` (boi canh du an), `safety` (ranh gioi / dieu cam).
 *    Moi kind co gioi han ky tu cung rieng (giong LETTA_CORE_LIMITS
 *    cua v9, mo rong them `task` + `safety`); label khong thuoc 5
 *    kind he thong la `custom` (gioi han mac dinh cua store).
 *  - `renderMemoryBlocksXml(botId, store)`: bien dich cac block da
 *    attach vao bot thanh mot doan `<memory_blocks>` dat vao system
 *    prompt — thu tu: human -> persona -> task -> project ->
 *    safety -> custom (theo thu tu attach trong tung nhom). Noi dung
 *    duoc escape XML de khong vo cau truc prompt.
 *  - `parseMemoryBlocksXml(xml)`: doc nguoc (round-trip cho test va
 *    cho tool kiem tra prompt da render) — chi doc, khong tin cay
 *    hoan toan nhu mot parser XML day du (chi du cho dinh dang do
 *    chinh module nay sinh ra).
 *  - `ensureTypedBlock(...)`: tao + attach block dung kind (dung
 *    gioi han cua kind, khong dung gioi han mac dinh nua).
 *
 * Quy tac dat ten: label la slug (normalizeBlockLabel cua store);
 * kind suy ra tu label: `human`/`persona`/`task`/`project`/`safety`
 * la kind he thong, con lai la `custom`. Mot label he thong KHONG
 * duoc dung cho kind khac (vd label `task` luon la kind `task`).
 */

import { MemoryBlockStore, normalizeBlockLabel, DEFAULT_BLOCK_CHAR_LIMIT } from '../blocks';
import type { MemoryBlock } from '../blocks';

/** 5 kind he thong cua memory v11 (them `task` + `safety` so voi v9). */
export const V11_SYSTEM_KINDS = ['human', 'persona', 'task', 'project', 'safety'] as const;
export type V11BlockKind = (typeof V11_SYSTEM_KINDS)[number] | 'custom';

/** Gioi han ky tu cung cua tung kind he thong. */
export const V11_KIND_LIMITS: Readonly<Record<string, number>> = {
  persona: 2048,
  human: 4096,
  task: 4096,
  project: 8192,
  safety: 2048,
};

/** Gioi han mac dinh cho block custom (bang gioi han mac dinh cua store). */
export const V11_CUSTOM_BLOCK_LIMIT = DEFAULT_BLOCK_CHAR_LIMIT;

/** Thu tu render cac kind vao `<memory_blocks>` (he thong truoc, custom sau). */
export const V11_KIND_RENDER_ORDER: readonly V11BlockKind[] = [
  'human',
  'persona',
  'task',
  'project',
  'safety',
  'custom',
];

/** true khi label (sau slug hoa) la mot trong 5 kind he thong. */
export function isV11SystemKindLabel(label: string): boolean {
  const slug = normalizeBlockLabel(label ?? '');
  return (V11_SYSTEM_KINDS as readonly string[]).includes(slug);
}

/**
 * Kind cua mot block, suy ra tu label cua no. Label he thong ->
 * kind do; label khac -> `custom`. Khong co cach nao de mot block
 * label `task` lai mang kind khac — kind la ham cua label.
 */
export function detectBlockKind(label: string): V11BlockKind {
  const slug = normalizeBlockLabel(label ?? '');
  if ((V11_SYSTEM_KINDS as readonly string[]).includes(slug)) {
    return slug as V11BlockKind;
  }
  return 'custom';
}

/** Gioi han ky tu ap cho mot kind (he thong co gioi han rieng, custom mac dinh). */
export function v11LimitForKind(kind: V11BlockKind): number {
  if (kind === 'custom') return V11_CUSTOM_BLOCK_LIMIT;
  return V11_KIND_LIMITS[kind] ?? V11_CUSTOM_BLOCK_LIMIT;
}

/** Gioi han ky tu ap cho mot label (suy kind tu label roi lay gioi han). */
export function v11LimitForLabel(label: string): number {
  return v11LimitForKind(detectBlockKind(label));
}

/** Mo ta mac dinh cua tung kind he thong (dung khi tao block moi). */
export const V11_KIND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  human: 'Facts about the user.',
  persona: 'How this bot behaves and speaks.',
  task: 'The task this bot is currently working on.',
  project: 'Project context this bot works in.',
  safety: 'Boundaries and things this bot must never do.',
};

/** Loi block kind — message tieng Viet, tool tra thang cho agent. */
export class V11BlockKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V11BlockKindError';
  }
}

/** Muc day cua mot block theo gioi han cua kind (de UI/tool canh bao truoc khi day). */
export interface V11BlockUsage {
  label: string;
  kind: V11BlockKind;
  chars: number;
  limit: number;
  /** Ty le day 0..1 (co the > 1 neu block legacy vuot gioi han moi). */
  fillRatio: number;
  /** 'ok' < 70%, 'warm' 70-90%, 'full' > 90%. */
  state: 'ok' | 'warm' | 'full';
}

export function v11BlockUsage(block: MemoryBlock): V11BlockUsage {
  const kind = detectBlockKind(block.label);
  const limit = block.charLimit > 0 ? block.charLimit : v11LimitForKind(kind);
  const fillRatio = limit > 0 ? block.content.length / limit : 0;
  return {
    label: block.label,
    kind,
    chars: block.content.length,
    limit,
    fillRatio,
    state: fillRatio >= 0.9 ? 'full' : fillRatio >= 0.7 ? 'warm' : 'ok',
  };
}

/** Escape noi dung block de dat an toan trong `<memory_blocks>` XML. */
export function escapeMemoryBlockXml(text: string): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Unescape (nguoc cua escapeMemoryBlockXml). */
export function unescapeMemoryBlockXml(text: string): string {
  return (text ?? '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** Mot block da render trong `<memory_blocks>`. */
export interface V11RenderedBlock {
  label: string;
  kind: V11BlockKind;
  version: number;
  description: string;
  content: string;
}

/**
 * Sap xep block theo thu tu render: kind he thong truoc (theo
 * V11_KIND_RENDER_ORDER), trong cung kind giu nguyen thu tu attach;
 * block custom xep sau cung, giu thu tu attach.
 */
export function sortBlocksForRender(blocks: MemoryBlock[]): MemoryBlock[] {
  const order = new Map<string, number>(V11_KIND_RENDER_ORDER.map((k, i) => [k, i]));
  return [...blocks].sort((a, b) => {
    const ka = order.get(detectBlockKind(a.label)) ?? 99;
    const kb = order.get(detectBlockKind(b.label)) ?? 99;
    return ka - kb;
  });
}

/**
 * Bien dich cac block da attach vao bot thanh doan `<memory_blocks>`
 * de ghep vao system prompt. Block trong thi van render (de agent
 * biet block ton tai nhung chua co noi dung); block chua attach thi
 * khong bao gio lot vao. Tra '' khi bot khong attach block nao.
 *
 * Dinh dang (giong Letta, tu thiet ke lai):
 *   <memory_blocks>
 *   <block label="human" kind="human" version="3" description="...">
 *   ...noi dung...
 *   </block>
 *   ...
 *   </memory_blocks>
 */
export function renderMemoryBlocksXml(botId: string, store: MemoryBlockStore): string {
  const attached = sortBlocksForRender(store.listAttached(botId));
  if (attached.length === 0) return '';
  const lines: string[] = ['<memory_blocks>'];
  for (const block of attached) {
    const kind = detectBlockKind(block.label);
    const label = escapeMemoryBlockXml(block.label);
    const description = escapeMemoryBlockXml(block.description ?? '');
    lines.push(
      `<block label="${label}" kind="${kind}" version="${block.version}" description="${description}">`,
    );
    lines.push(escapeMemoryBlockXml(block.content));
    lines.push('</block>');
  }
  lines.push('</memory_blocks>');
  return lines.join('\n');
}

/**
 * Doc nguoc doan `<memory_blocks>` do renderMemoryBlocksXml sinh ra.
 * Tra danh sach block (theo thu tu xuat hien). XML lech dinh dang ->
 * throw V11BlockKindError (khong doan mo).
 */
export function parseMemoryBlocksXml(xml: string): V11RenderedBlock[] {
  const text = (xml ?? '').trim();
  if (text === '') return [];
  if (!text.startsWith('<memory_blocks>') || !text.endsWith('</memory_blocks>')) {
    throw new V11BlockKindError('Not a <memory_blocks> document.');
  }
  const inner = text.slice('<memory_blocks>'.length, -'</memory_blocks>'.length);
  const out: V11RenderedBlock[] = [];
  const re =
    /<block label="([^"]*)" kind="([^"]*)" version="(\d+)" description="([^"]*)">\n([\s\S]*?)\n<\/block>/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = re.exec(inner)) !== null) {
    consumed = re.lastIndex;
    const [, label, kind, version, description, content] = match;
    out.push({
      label: unescapeMemoryBlockXml(label),
      kind: (kind === 'custom' || (V11_SYSTEM_KINDS as readonly string[]).includes(kind)
        ? kind
        : 'custom') as V11BlockKind,
      version: Number.parseInt(version, 10),
      description: unescapeMemoryBlockXml(description),
      content: unescapeMemoryBlockXml(content ?? ''),
    });
  }
  const rest = inner.slice(consumed).trim();
  if (rest !== '') {
    throw new V11BlockKindError('Unparsed content inside <memory_blocks>.');
  }
  return out;
}

/**
 * Tao block dung kind (neu chua co) + attach vao bot. Gioi han lay
 * theo kind, khong dung gioi han mac dinh cua store nua. Block da
 * ton tai thi chi attach (khong doi gioi han cu). Tra block hien tai.
 */
export function ensureTypedBlock(
  store: MemoryBlockStore,
  botId: string,
  label: string,
  actor = 'user',
  description?: string,
): MemoryBlock {
  const slug = normalizeBlockLabel(label);
  if (slug === '') {
    throw new V11BlockKindError('Block label is empty.');
  }
  const kind = detectBlockKind(slug);
  const existing = store.get(slug);
  const block =
    existing ??
    store.create(
      {
        label: slug,
        description:
          description ?? V11_KIND_DESCRIPTIONS[kind] ?? `Memory block "${slug}".`,
        content: '',
        charLimit: v11LimitForKind(kind),
        createdByBotId: botId,
      },
      actor,
    );
  if (!store.isAttached(botId, block.id)) {
    store.attach(botId, block.id, actor);
  }
  return store.get(block.id) ?? block;
}

/**
 * Tao du 5 block he thong cho bot moi (idempotent — block da co thi
 * chi attach). Tra danh sach block hien tai theo thu tu render.
 */
export function ensureAllSystemBlocks(
  store: MemoryBlockStore,
  botId: string,
  actor = 'user',
): MemoryBlock[] {
  const out: MemoryBlock[] = [];
  for (const kind of V11_SYSTEM_KINDS) {
    out.push(ensureTypedBlock(store, botId, kind, actor));
  }
  return sortBlocksForRender(out);
}
