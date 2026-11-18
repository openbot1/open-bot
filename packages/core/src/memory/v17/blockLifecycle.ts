/**
 * Memory v17 — Block lifecycle v2 (v1.18, Doi T1).
 *
 * Y tuong hoc tu Letta/MemGPT (core memory blocks: persona/human
 * luon trong context, agent tu sua qua tool calls; block co gioi
 * han kich thuoc rieng) — tu thiet ke lai hoan toan cho open-bot,
 * chay 100% local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `V15BlockStore` / `applyBlockEditV15` / `compileBlocksV15` /
 *    `V15_MAX_BLOCK_CHARS` / `V15_MAX_BLOCKS` cua memoryV15/blocks:
 *    store block co version/history; v17 la lop LIFECYCLE ben tren
 *    (pin/read-only/gioi han ky tu rieng/quota), KHONG sua engine.
 *  - `V15BlockKind` cua v15: 5 kind (persona/human/task/system/
 *    custom); template v17 chi dung cac kind nay.
 *
 * Moi trong v17:
 *  1. Vong doi block: `pin` (luon compile dau tien, khong bi sleep
 *     reorganizer gop/cat), `readOnly` (chan moi edit ke ca cua
 *     agent — chi user mo khoa duoc), gioi han ky tu RIENG tung
 *     block (`maxChars`, mac dinh = gioi han v15), quota tong
 *     (`totalQuotaChars` — tong ky tu tat ca block khong vuot qua).
 *  2. Block templates: 5 mau co san — `persona`, `human`,
 *     `custom`, `project`, `skill` — moi mau co kind, noi dung
 *     mac dinh voi bien `{{tenBien}}` (vd `{{userName}}`,
 *     `{{projectName}}`), mo ta va danh sach bien bat buoc. Tao
 *     block tu template qua `createBlockFromTemplateV17`.
 *  - 3. `V17BlockLifecycleManager`: boc V15BlockStore, ap dung
 *     lifecycle truoc moi edit (readOnly -> tu choi; vuot maxChars
 *     rieng -> tu choi kem goi y cat ngan; vuot quota tong -> tu
 *     choi), luu cau hinh lifecycle xuong file JSON (host tu luu),
 *     bao cao quota (`quotaReportV17`) va danh sach block theo
 *     trang thai (`listPinnedV17`, `listReadOnlyV17`).
 *  - 4. Compile co pin: `compileBlocksWithLifecycleV17` — block
 *     pin len dau (theo thu tu pin), roi moi den thu tu kind cua
 *     v15; block readOnly van compile binh thuong (chi cam sua).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  V15BlockStore,
  V15_MAX_BLOCK_CHARS,
  V15_MAX_BLOCKS,
  applyBlockEditV15,
  compileBlocksV15,
  isValidBlockLabelV15,
  normalizeBlockLabelV15,
} from '../../memoryV15/blocks';
import type { V15BlockEditOp, V15BlockKind, V15MemoryBlock } from '../../memoryV15/blocks';

/** Loi lifecycle block v17 — message tieng Viet. */
export class V17BlockLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V17BlockLifecycleError';
  }
}

/** Ten template block v17. */
export type V17BlockTemplateName = 'persona' | 'human' | 'custom' | 'project' | 'skill';

/** Dinh nghia mot block template. */
export interface V17BlockTemplate {
  /** Ten mau (dung de goi khi tao block). */
  name: V17BlockTemplateName;
  /** Kind v15 cua block tao ra. */
  kind: V15BlockKind;
  /** Mo ta ngan (UI hien thi). */
  description: string;
  /** Bien bat buoc phai truyen khi render (ten bien, khong co {{}}). */
  requiredVars: string[];
  /** Bien tuy chon (co gia tri mac dinh). */
  optionalVars: Record<string, string>;
  /** Noi dung mau — bien viet dang {{tenBien}}. */
  content: string;
}

/** 5 template co san cua v17. */
export const V17_BLOCK_TEMPLATES: Readonly<Record<V17BlockTemplateName, V17BlockTemplate>> = {
  persona: {
    name: 'persona',
    kind: 'persona',
    description: 'Block persona: agent la ai, giong noi, rang buoc hanh vi.',
    requiredVars: ['agentName'],
    optionalVars: { tone: 'than thien, ngan gon', language: 'tieng Viet' },
    content:
      'Toi la {{agentName}}, tro ly AI chay local-first tren may cua user.\n' +
      'Giong noi: {{tone}}.\n' +
      'Ngon ngu tra loi mac dinh: {{language}}.\n' +
      'Nguyen tac: chi lam viec user giao, khong tu y gui du lieu ra ngoai, hoi lai khi mo ho.',
  },
  human: {
    name: 'human',
    kind: 'human',
    description: 'Block human: user la ai, so thich, muc tieu.',
    requiredVars: ['userName'],
    optionalVars: { timezone: 'Asia/Saigon', goal: '' },
    content:
      'User: {{userName}}.\n' +
      'Mui gio: {{timezone}}.\n' +
      'So thich va muc tieu: {{goal}}',
  },
  custom: {
    name: 'custom',
    kind: 'custom',
    description: 'Block custom trong: bat dau tu noi dung do user tu viet.',
    requiredVars: [],
    optionalVars: { title: 'Ghi chu' },
    content: '# {{title}}\n\n(Ghi chu cua user — sua lai noi dung nay.)',
  },
  project: {
    name: 'project',
    kind: 'custom',
    description: 'Block project: boi canh mot du an / codebase dang lam.',
    requiredVars: ['projectName'],
    optionalVars: { stack: '', repoPath: '' },
    content:
      'Du an: {{projectName}}.\n' +
      'Stack: {{stack}}.\n' +
      'Repo: {{repoPath}}.\n' +
      'Quy uoc: chay test truoc khi bao xong, khong commit key that.',
  },
  skill: {
    name: 'skill',
    kind: 'custom',
    description: 'Block skill: mot ky nang agent biet dung, kem trigger.',
    requiredVars: ['skillName'],
    optionalVars: { trigger: '', notes: '' },
    content:
      'Skill: {{skillName}}.\n' +
      'Khi nao dung: {{trigger}}.\n' +
      'Ghi chu: {{notes}}',
  },
};

/** Liet ke ten template co san. */
export function listBlockTemplatesV17(): V17BlockTemplateName[] {
  return Object.keys(V17_BLOCK_TEMPLATES) as V17BlockTemplateName[];
}

/** Lay dinh nghia mot template (undefined neu khong co). */
export function getBlockTemplateV17(name: string): V17BlockTemplate | undefined {
  const key = (name ?? '').trim().toLowerCase();
  return (V17_BLOCK_TEMPLATES as Record<string, V17BlockTemplate>)[key];
}

/**
 * Render mot template thanh noi dung block: thay bien {{x}} bang
 * gia tri truyen vao (uu tien hon mac dinh); bien bat buoc thieu
 * thi throw; bien thua (khong co trong template) thi throw de
 * tranh go nham ten bien; bien `{{...}}` nao con sot lai sau khi
 * thay thi throw (template loi).
 */
export function renderBlockTemplateV17(
  name: string,
  vars: Record<string, string> = {},
): { content: string; template: V17BlockTemplate } {
  const template = getBlockTemplateV17(name);
  if (!template) {
    throw new V17BlockLifecycleError(
      `Khong co template block "${name}" (co san: ${listBlockTemplatesV17().join(', ')}).`,
    );
  }
  const known = new Set<string>([...template.requiredVars, ...Object.keys(template.optionalVars)]);
  for (const key of Object.keys(vars)) {
    if (!known.has(key)) {
      throw new V17BlockLifecycleError(
        `Template "${name}" khong co bien "${key}" (bien hop le: ${[...known].join(', ') || '(khong co)'}).`,
      );
    }
  }
  for (const req of template.requiredVars) {
    if ((vars[req] ?? '').trim() === '') {
      throw new V17BlockLifecycleError(`Template "${name}" can bien bat buoc "${req}".`);
    }
  }
  const values: Record<string, string> = { ...template.optionalVars, ...vars };
  let content = template.content;
  for (const [key, value] of Object.entries(values)) {
    content = content.split(`{{${key}}}`).join(value);
  }
  const leftover = content.match(/\{\{[^}]+\}\}/);
  if (leftover) {
    throw new V17BlockLifecycleError(
      `Template "${name}" con bien chua thay gia tri: ${leftover[0]}.`,
    );
  }
  return { content, template };
}

/** Cau hinh lifecycle cua mot block. */
export interface V17BlockLifecycleConfig {
  label: string;
  /** true = block pin: compile dau tien, sleep reorganizer khong gop/cat. */
  pinned: boolean;
  /** true = chi doc: moi edit (ke ca cua agent) deu bi tu choi. */
  readOnly: boolean;
  /** Gioi han ky tu rieng cua block (mac dinh = gioi han v15). */
  maxChars: number;
  /** Template goc (neu tao tu template). */
  template?: V17BlockTemplateName;
  /** Ai cap nhat cau hinh lan cuoi. */
  updatedBy: string;
  updatedAt: string;
}

/** Gioi han tong ky tu mac dinh cua tat ca block (quota). */
export const V17_DEFAULT_TOTAL_QUOTA_CHARS = V15_MAX_BLOCK_CHARS * 8;
/** So block pin toi da (de prompt khong bi pin chiem het). */
export const V17_MAX_PINNED_BLOCKS = 8;

/** JSON serialize cau hinh lifecycle (de host luu file). */
export interface V17LifecycleConfigJson {
  version: 1;
  totalQuotaChars: number;
  blocks: V17BlockLifecycleConfig[];
  updatedAt: string;
}

function nowIsoV17(): string {
  return new Date().toISOString();
}

function defaultLifecycleConfigV17(label: string, actor: string): V17BlockLifecycleConfig {
  return {
    label,
    pinned: false,
    readOnly: false,
    maxChars: V15_MAX_BLOCK_CHARS,
    updatedBy: actor,
    updatedAt: nowIsoV17(),
  };
}

/** Bao cao quota tong. */
export interface V17QuotaReport {
  totalChars: number;
  totalQuotaChars: number;
  /** So ky tu con lai (am = da vuot quota). */
  remainingChars: number;
  /** true = da vuot quota. */
  overQuota: boolean;
  blockCount: number;
  maxBlocks: number;
  /** Block lon nhat (de UI goi y cat). */
  largestBlock: { label: string; chars: number } | null;
  /** Cac block gan vuot gioi han rieng (>= 90%). */
  nearLimit: Array<{ label: string; chars: number; maxChars: number; pct: number }>;
}

/**
 * Manager lifecycle block v17 — boc V15BlockStore. Moi edit di qua
 * `guardEdit` truoc: block readOnly -> tu choi; noi dung moi vuot
 * maxChars rieng -> tu choi kem goi y; tong vuot quota -> tu choi.
 * Cau hinh lifecycle luu trong bo nho cua manager; host goi
 * `toJson`/`fromJson` de luu file tuy y (manager khong tu ghi dia).
 */
export class V17BlockLifecycleManager {
  private readonly configs = new Map<string, V17BlockLifecycleConfig>();
  private totalQuotaChars: number;

  constructor(
    private readonly store: V15BlockStore,
    opts: { totalQuotaChars?: number } = {},
  ) {
    this.totalQuotaChars = opts.totalQuotaChars ?? V17_DEFAULT_TOTAL_QUOTA_CHARS;
  }

  /** Quota tong hien tai. */
  get quota(): number {
    return this.totalQuotaChars;
  }

  /** Doi quota tong (phai >= tong ky tu hien tai). */
  setTotalQuota(chars: number, actor = 'user'): number {
    const n = Math.floor(chars);
    if (!Number.isInteger(n) || n <= 0) {
      throw new V17BlockLifecycleError('Quota tong phai la so nguyen duong.');
    }
    if (n < this.store.totalChars()) {
      throw new V17BlockLifecycleError(
        `Quota ${n} nho hon tong ky tu hien tai ${this.store.totalChars()} — cat bot block truoc.`,
      );
    }
    this.totalQuotaChars = n;
    void actor;
    return this.totalQuotaChars;
  }

  /** Store block goc (de host dung truc tiep khi can). */
  get blockStore(): V15BlockStore {
    return this.store;
  }

  /** Cau hinh lifecycle cua mot block (mac dinh neu chua co). */
  configOf(label: string): V17BlockLifecycleConfig {
    const key = normalizeBlockLabelV15(label);
    const found = this.configs.get(key);
    if (found) return { ...found };
    return defaultLifecycleConfigV17(key, 'system');
  }

  private configKey(label: string): string {
    return normalizeBlockLabelV15(label);
  }

  private ensureConfig(label: string, actor: string): V17BlockLifecycleConfig {
    const key = this.configKey(label);
    let cfg = this.configs.get(key);
    if (!cfg) {
      cfg = defaultLifecycleConfigV17(key, actor);
      this.configs.set(key, cfg);
    }
    return cfg;
  }

  private touch(cfg: V17BlockLifecycleConfig, actor: string): void {
    cfg.updatedBy = actor;
    cfg.updatedAt = nowIsoV17();
  }

  /** Pin / bo pin mot block (toi da 8 block pin). */
  setPinned(label: string, pinned: boolean, actor = 'user'): V17BlockLifecycleConfig {
    const block = this.store.get(label);
    if (!block) throw new V17BlockLifecycleError(`Khong tim thay block "${label}".`);
    const cfg = this.ensureConfig(block.label, actor);
    if (pinned && !cfg.pinned) {
      const pinnedCount = this.store
        .list()
        .filter((b) => this.configOf(b.label).pinned).length;
      if (pinnedCount >= V17_MAX_PINNED_BLOCKS) {
        throw new V17BlockLifecycleError(
          `Da pin toi da ${V17_MAX_PINNED_BLOCKS} block — bo pin block khac truoc.`,
        );
      }
    }
    cfg.pinned = pinned;
    this.touch(cfg, actor);
    return { ...cfg };
  }

  /** Bat/tat che do chi doc cua mot block. */
  setReadOnly(label: string, readOnly: boolean, actor = 'user'): V17BlockLifecycleConfig {
    const block = this.store.get(label);
    if (!block) throw new V17BlockLifecycleError(`Khong tim thay block "${label}".`);
    const cfg = this.ensureConfig(block.label, actor);
    cfg.readOnly = readOnly;
    this.touch(cfg, actor);
    return { ...cfg };
  }

  /** Dat gioi han ky tu rieng cho mot block (1..gioi han v15). */
  setMaxChars(label: string, maxChars: number, actor = 'user'): V17BlockLifecycleConfig {
    const block = this.store.get(label);
    if (!block) throw new V17BlockLifecycleError(`Khong tim thay block "${label}".`);
    const n = Math.floor(maxChars);
    if (!Number.isInteger(n) || n < 1 || n > V15_MAX_BLOCK_CHARS) {
      throw new V17BlockLifecycleError(
        `Gioi han ky tu rieng phai trong [1, ${V15_MAX_BLOCK_CHARS}].`,
      );
    }
    if (block.content.length > n) {
      throw new V17BlockLifecycleError(
        `Block "${label}" dang co ${block.content.length} ky tu, vuot gioi han moi ${n} — cat bot truoc.`,
      );
    }
    const cfg = this.ensureConfig(block.label, actor);
    cfg.maxChars = n;
    this.touch(cfg, actor);
    return { ...cfg };
  }

  /** Tao block tu template (ghi lai template goc vao cau hinh). */
  createFromTemplate(
    templateName: string,
    label: string,
    vars: Record<string, string> = {},
    actor = 'user',
  ): V15MemoryBlock {
    const cleanLabel = normalizeBlockLabelV15(label);
    if (!isValidBlockLabelV15(cleanLabel)) {
      throw new V17BlockLifecycleError(`Label block khong hop le: "${label}".`);
    }
    const { content, template } = renderBlockTemplateV17(templateName, vars);
    const block = this.store.create(cleanLabel, template.kind, content, actor);
    const cfg = this.ensureConfig(block.label, actor);
    cfg.template = template.name;
    this.touch(cfg, actor);
    return { ...block, history: [...block.history] };
  }

  /**
   * Kiem tra mot edit co duoc phep khong (khong doi store):
   * tra ve ly do tu choi, hoac null = duoc phep. Dung truoc khi
   * goi `applyBlockEditV15` de UI bao loi som.
   */
  checkEdit(op: V15BlockEditOp, actor = 'agent'): string | null {
    const label = normalizeBlockLabelV15(op.label ?? '');
    const cfg = this.configOf(label);
    const existing = this.store.get(label);
    if (op.action === 'create') {
      if (this.store.size >= V15_MAX_BLOCKS) {
        return `Da dat gioi han ${V15_MAX_BLOCKS} block — xoa/gop block truoc.`;
      }
      const content = op.content ?? '';
      if (content.length > cfg.maxChars) {
        return `Noi dung moi ${content.length} ky tu vuot gioi han block ${cfg.maxChars} — chia nho truoc.`;
      }
      if (this.store.totalChars() + content.length > this.totalQuotaChars) {
        return `Vuot quota tong ${this.totalQuotaChars} ky tu (hien ${this.store.totalChars()}, them ${content.length}) — cat bot block khac truoc.`;
      }
      return null;
    }
    if (!existing) return `Khong tim thay block "${label}".`;
    if (cfg.readOnly) {
      return `Block "${label}" dang chi doc (read-only) — chi user mo khoa moi sua duoc.`;
    }
    if (op.action === 'delete') return null;
    let nextLen = existing.content.length;
    if (op.action === 'replace') nextLen = (op.content ?? '').length;
    if (op.action === 'append') nextLen = existing.content.length + 1 + (op.text ?? '').length;
    if (op.action === 'insert') nextLen = existing.content.length + (op.text ?? '').length;
    if (op.action === 'delete_range') {
      nextLen = existing.content.length - ((op.end ?? 0) - (op.start ?? 0));
    }
    if (nextLen > cfg.maxChars) {
      return `Edit xong block se dai ${nextLen} ky tu, vuot gioi han rieng ${cfg.maxChars} cua block "${label}" — cat ngan truoc.`;
    }
    if (nextLen > existing.content.length && this.store.totalChars() + (nextLen - existing.content.length) > this.totalQuotaChars) {
      return `Vuot quota tong ${this.totalQuotaChars} ky tu — cat bot block khac truoc.`;
    }
    void actor;
    return null;
  }

  /** Ap dung mot edit co guard lifecycle (throw neu bi chan). */
  applyEdit(op: V15BlockEditOp, actor = 'agent'): ReturnType<typeof applyBlockEditV15> {
    const reason = this.checkEdit(op, actor);
    if (reason) throw new V17BlockLifecycleError(reason);
    return applyBlockEditV15(this.store, op, actor);
  }

  /** Xoa block (block pin van xoa duoc — pin chi anh huong compile/sleep). */
  deleteBlock(label: string): boolean {
    const block = this.store.get(label);
    if (!block) return false;
    this.configs.delete(this.configKey(block.label));
    return this.store.delete(block.label);
  }

  /** Cac block dang pin (theo thu tu compile). */
  listPinned(): V15MemoryBlock[] {
    return this.store
      .list()
      .filter((b) => this.configOf(b.label).pinned);
  }

  /** Cac block dang chi doc. */
  listReadOnly(): V15MemoryBlock[] {
    return this.store
      .list()
      .filter((b) => this.configOf(b.label).readOnly);
  }

  /** Bao cao quota tong + block gan vuot gioi han rieng. */
  quotaReport(): V17QuotaReport {
    const total = this.store.totalChars();
    const blocks = this.store.list();
    let largest: { label: string; chars: number } | null = null;
    const nearLimit: V17QuotaReport['nearLimit'] = [];
    for (const b of blocks) {
      if (!largest || b.content.length > largest.chars) {
        largest = { label: b.label, chars: b.content.length };
      }
      const cfg = this.configOf(b.label);
      const pct = cfg.maxChars > 0 ? b.content.length / cfg.maxChars : 0;
      if (pct >= 0.9) {
        nearLimit.push({ label: b.label, chars: b.content.length, maxChars: cfg.maxChars, pct });
      }
    }
    nearLimit.sort((a, b) => b.pct - a.pct);
    return {
      totalChars: total,
      totalQuotaChars: this.totalQuotaChars,
      remainingChars: this.totalQuotaChars - total,
      overQuota: total > this.totalQuotaChars,
      blockCount: blocks.length,
      maxBlocks: V15_MAX_BLOCKS,
      largestBlock: largest,
      nearLimit,
    };
  }

  /** Serialize cau hinh lifecycle (host tu luu file). */
  toJson(now = new Date()): V17LifecycleConfigJson {
    return {
      version: 1,
      totalQuotaChars: this.totalQuotaChars,
      blocks: [...this.configs.values()].map((c) => ({ ...c })),
      updatedAt: now.toISOString(),
    };
  }

  /** Nap cau hinh lifecycle tu JSON (bo qua muc hong). */
  static fromJson(store: V15BlockStore, json: V17LifecycleConfigJson): V17BlockLifecycleManager {
    const manager = new V17BlockLifecycleManager(store, {
      totalQuotaChars: json?.totalQuotaChars ?? V17_DEFAULT_TOTAL_QUOTA_CHARS,
    });
    if (json && json.version === 1 && Array.isArray(json.blocks)) {
      for (const c of json.blocks) {
        if (!c || typeof c.label !== 'string') continue;
        const key = normalizeBlockLabelV15(c.label);
        if (!isValidBlockLabelV15(key)) continue;
        manager.configs.set(key, {
          label: key,
          pinned: c.pinned === true,
          readOnly: c.readOnly === true,
          maxChars:
            typeof c.maxChars === 'number' && c.maxChars >= 1 && c.maxChars <= V15_MAX_BLOCK_CHARS
              ? Math.floor(c.maxChars)
              : V15_MAX_BLOCK_CHARS,
          ...(c.template ? { template: c.template } : {}),
          updatedBy: typeof c.updatedBy === 'string' ? c.updatedBy : 'system',
          updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : nowIsoV17(),
        });
      }
    }
    return manager;
  }
}

/** Duong dan file cau hinh lifecycle (tuong doi workspace). */
export const V17_LIFECYCLE_CONFIG_REL_PATH = path.join('.open-bot', 'memory-v17-lifecycle.json');

/** Doc cau hinh lifecycle tu workspace (khong co file -> manager moi). */
export function loadLifecycleConfigV17(
  store: V15BlockStore,
  workspaceDir: string,
): V17BlockLifecycleManager {
  try {
    const filePath = path.join(workspaceDir, V17_LIFECYCLE_CONFIG_REL_PATH);
    if (!fs.existsSync(filePath)) return new V17BlockLifecycleManager(store);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as V17LifecycleConfigJson;
    return V17BlockLifecycleManager.fromJson(store, parsed);
  } catch {
    return new V17BlockLifecycleManager(store);
  }
}

/** Ghi cau hinh lifecycle xuong workspace (best-effort). */
export function saveLifecycleConfigV17(workspaceDir: string, manager: V17BlockLifecycleManager): void {
  try {
    const filePath = path.join(workspaceDir, V17_LIFECYCLE_CONFIG_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(manager.toJson(), null, 2)}\n`, 'utf8');
  } catch {
    // Cau hinh best-effort: mat file chi mat pin/readOnly, khong mat block.
  }
}

/**
 * Compile block co lifecycle: block pin len dau (theo thu tu pin
 * — thu tu tao), roi den cac block con lai theo thu tu kind cua
 * v15. Block readOnly van compile binh thuong (chi cam sua).
 */
export function compileBlocksWithLifecycleV17(
  manager: V17BlockLifecycleManager,
  opts: { includeKinds?: V15BlockKind[] } = {},
): string {
  const pinned = manager.listPinned().filter((b) => !opts.includeKinds || opts.includeKinds.includes(b.kind));
  const pinnedLabels = new Set(pinned.map((b) => b.label));
  const rest = manager.blockStore
    .list()
    .filter((b) => !pinnedLabels.has(b.label))
    .filter((b) => !opts.includeKinds || opts.includeKinds.includes(b.kind));
  const ordered = [...pinned, ...rest];
  if (ordered.length === 0) return '';
  const lines = ['<memory_blocks>'];
  for (const b of ordered) {
    const cfg = manager.configOf(b.label);
    const flags: string[] = [];
    if (cfg.pinned) flags.push('pinned');
    if (cfg.readOnly) flags.push('read-only');
    lines.push(`[${b.kind}:${b.label}] (v${b.version}${flags.length > 0 ? ` ${flags.join(',')}` : ''})`);
    lines.push(b.content);
  }
  lines.push('</memory_blocks>');
  return lines.join('\n');
}

/** Compile bang v15 (khong tinh pin) — de test doi chieu. */
export function compileBlocksPlainV17(store: V15BlockStore): string {
  return compileBlocksV15(store);
}
