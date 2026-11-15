/**
 * Sub-agent task visualizer — cay task trong chat UI (v1.11, Doi T4).
 *
 * Y tuong hoc tu OpenHands 1.39 sub-agent task visualizer (chi hoc y
 * tuong, tu thiet ke va viet lai hoan toan tu dau — KHONG doc, KHONG
 * copy code/text/tai san cua bat ky repo nao, cua xAI/Cursor).
 *
 * Mo hinh: mot cay task (root = task lon cua agent chinh, node con =
 * sub-agent / buoc nho). Moi node co trang thai, tien do 0-100, log
 * rut gon (cap so dong), model dang chay, token da dung, loi (khi
 * fail). Cay la pure data + class quan ly:
 *
 *   - version tang moi lan doi (host dung de biet snapshot nao moi,
 *     UI chi render lai khi version doi — live update re tien);
 *   - tien do tong = trung binh tien do cac la (leaf), de quy len root;
 *   - diffSince(prevSnapshot): id cac node da doi (trang thai/tien do/
 *     so dong log) — UI chi cap nhat cac dong do;
 *   - renderText(): cay text thut le de chat UI hien ban text khi
 *     chua co component React, hoac de log/debug.
 *
 * Module nay thuan tuy (khong fs, khong goi LLM): host cap nhat cay
 * khi sub-agent chay; test cap nhat truc tiep.
 *
 * Gioi han trung thuc:
 *   - tien do la con so do caller bao (host uoc luong), khong do that.
 *   - log chi giu dong cuoi (cap mac dinh 50 dong/node); dong cu hon
 *     bi cat va dem trong logTruncated.
 *   - cay song trong bo nho cua process; muon ben vung phai serialize
 *     (serialize/parse) ra dia — host tu lam.
 */

export type CodingV4TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** Trang thai hien thi ngan cho UI (de dich qua i18n key). */
export const CODING_V4_TASK_STATUSES: CodingV4TaskStatus[] = [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
];

/** So dong log toi da giu moi node (mac dinh). */
export const CODING_V4_DEFAULT_MAX_LOG_LINES = 50;

/** Bieu tuong text cho tung trang thai (dung trong renderText). */
export const CODING_V4_STATUS_ICONS: Record<CodingV4TaskStatus, string> = {
  pending: '[..]',
  running: '[>>]',
  done: '[OK]',
  failed: '[!!]',
  cancelled: '[--]',
};

export interface CodingV4TaskNode {
  id: string;
  parentId: string | null;
  title: string;
  /** Mo ta ngan (spec rut gon) — hien trong chi tiet. */
  detail?: string;
  status: CodingV4TaskStatus;
  /** Tien do 0-100 (la: do caller bao; node cha: tong hop tu con). */
  progress: number;
  /** Dong log rut gon (dong moi nhat o cuoi). */
  log: string[];
  /** So dong log da bi cat vi vuot cap. */
  logTruncated: number;
  /** Model dang chay node nay (vd "ollama/qwen2.5-coder:7b"). */
  model?: string;
  /** Token da dung cho node nay. */
  tokensUsed?: number;
  /** Loi khi status = failed (hoac ly do cancel). */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  children: CodingV4TaskNode[];
}

export interface CodingV4TaskTreeSnapshot {
  version: number;
  root: CodingV4TaskNode;
  counts: Record<CodingV4TaskStatus, number>;
  totalNodes: number;
  /** Tien do tong (0-100): trung binh cac la. */
  overallProgress: number;
  updatedAt: string;
}

export interface CodingV4AddTaskOptions {
  detail?: string;
  model?: string;
  /** Id tu chon; mac dinh sinh `task-<n>`. */
  id?: string;
}

export interface CodingV4UpdateTaskPatch {
  status?: CodingV4TaskStatus;
  progress?: number;
  /** Them 1 dong log (bi cat khi vuot cap). */
  logLine?: string;
  /** Them nhieu dong log cung luc. */
  logLines?: string[];
  model?: string;
  tokensUsed?: number;
  error?: string;
  detail?: string;
}

/** Trang thai ket thuc (khong cap nhat tien do/log sau do nua, tru log). */
const TERMINAL_STATUSES: ReadonlySet<CodingV4TaskStatus> = new Set([
  'done',
  'failed',
  'cancelled',
]);

function clampProgress(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

function countStatuses(
  node: CodingV4TaskNode,
  counts: Record<CodingV4TaskStatus, number>,
): void {
  counts[node.status] += 1;
  for (const child of node.children) countStatuses(child, counts);
}

function collectLeaves(node: CodingV4TaskNode, out: CodingV4TaskNode[]): void {
  if (node.children.length === 0) {
    out.push(node);
    return;
  }
  for (const child of node.children) collectLeaves(child, out);
}

/**
 * Tien do cua mot node: la thi lay progress cua no; node cha thi lay
 * trung binh tien do cac con (de quy) — de root luon phan anh dung
 * tien do that cua cay thay vi con so caller tu bao.
 */
export function codingV4NodeProgress(node: CodingV4TaskNode): number {
  if (node.children.length === 0) return clampProgress(node.progress);
  const sum = node.children.reduce((acc, c) => acc + codingV4NodeProgress(c), 0);
  return Math.round(sum / node.children.length);
}

function cloneNode(node: CodingV4TaskNode): CodingV4TaskNode {
  return {
    ...node,
    log: [...node.log],
    children: node.children.map(cloneNode),
  };
}

function findNode(node: CodingV4TaskNode, id: string): CodingV4TaskNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function flattenInto(node: CodingV4TaskNode, out: CodingV4TaskNode[]): void {
  out.push(node);
  for (const child of node.children) flattenInto(child, out);
}

/**
 * Cay task cua sub-agent: root + cac node con, cap nhat live qua
 * version. Moi thay doi (them node, doi trang thai/tien do/log) deu
 * tang version va cap nhat updatedAt.
 */
export class CodingV4TaskTree {
  readonly sessionId: string;
  private readonly maxLogLines: number;
  private rootNode: CodingV4TaskNode;
  private counter = 1;
  private versionCounter = 0;
  private updatedAtValue: string;
  private readonly listeners = new Set<(snapshot: CodingV4TaskTreeSnapshot) => void>();

  constructor(rootTitle: string, options: { sessionId?: string; maxLogLines?: number; rootId?: string } = {}) {
    if (!rootTitle || rootTitle.trim() === '') {
      throw new Error('CodingV4TaskTree can title root khong rong.');
    }
    this.sessionId = options.sessionId ?? 'default';
    this.maxLogLines = Math.max(1, Math.floor(options.maxLogLines ?? CODING_V4_DEFAULT_MAX_LOG_LINES));
    const now = new Date().toISOString();
    this.updatedAtValue = now;
    this.rootNode = {
      id: options.rootId ?? 'root',
      parentId: null,
      title: rootTitle,
      status: 'pending',
      progress: 0,
      log: [],
      logTruncated: 0,
      startedAt: now,
      children: [],
    };
  }

  get version(): number {
    return this.versionCounter;
  }

  get root(): CodingV4TaskNode {
    return this.rootNode;
  }

  get updatedAt(): string {
    return this.updatedAtValue;
  }

  private touch(): void {
    this.versionCounter += 1;
    this.updatedAtValue = new Date().toISOString();
    if (this.listeners.size > 0) {
      const snapshot = this.snapshot();
      for (const listener of [...this.listeners]) {
        try {
          listener(snapshot);
        } catch {
          // Listener loi khong duoc lam hong cay task.
        }
      }
    }
  }

  /**
   * Dang ky nhan snapshot moi sau moi thay doi (live update cho chat
   * UI). Tra ham huy dang ky. Listener loi se bi bo qua, khong lam
   * hong cay.
   */
  onChange(listener: (snapshot: CodingV4TaskTreeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private nextId(): string {
    const id = `task-${this.counter}`;
    this.counter += 1;
    return id;
  }

  find(id: string): CodingV4TaskNode | null {
    return findNode(this.rootNode, id);
  }

  /** Them task con duoi `parentId` (mac dinh: root). Tra node moi. */
  addTask(parentId: string | null, title: string, options: CodingV4AddTaskOptions = {}): CodingV4TaskNode {
    if (!title || title.trim() === '') {
      throw new Error('CodingV4TaskTree.addTask can title khong rong.');
    }
    const parent = parentId === null ? this.rootNode : findNode(this.rootNode, parentId);
    if (!parent) throw new Error(`Khong tim thay task cha "${parentId}".`);
    const id = options.id ?? this.nextId();
    if (findNode(this.rootNode, id)) {
      throw new Error(`Task id "${id}" da ton tai trong cay.`);
    }
    const node: CodingV4TaskNode = {
      id,
      parentId: parent.id,
      title,
      status: 'pending',
      progress: 0,
      log: [],
      logTruncated: 0,
      children: [],
    };
    if (options.detail !== undefined) node.detail = options.detail;
    if (options.model !== undefined) node.model = options.model;
    parent.children.push(node);
    this.touch();
    return node;
  }

  private appendLog(node: CodingV4TaskNode, lines: string[]): void {
    for (const line of lines) {
      node.log.push(line);
      while (node.log.length > this.maxLogLines) {
        node.log.shift();
        node.logTruncated += 1;
      }
    }
  }

  /**
   * Cap nhat mot node. Tra false khi khong tim thay id. Dat status
   * ket thuc (done/failed/cancelled) se ghi finishedAt (neu chua co)
   * va dua progress ve 100 khi done, giu nguyen khi failed/cancelled.
   */
  updateTask(id: string, patch: CodingV4UpdateTaskPatch): boolean {
    const node = findNode(this.rootNode, id);
    if (!node) return false;
    if (patch.detail !== undefined) node.detail = patch.detail;
    if (patch.model !== undefined) node.model = patch.model;
    if (patch.tokensUsed !== undefined) node.tokensUsed = patch.tokensUsed;
    if (patch.error !== undefined) node.error = patch.error;
    if (patch.logLine !== undefined) this.appendLog(node, [patch.logLine]);
    if (patch.logLines !== undefined) this.appendLog(node, patch.logLines);
    if (patch.progress !== undefined) node.progress = clampProgress(patch.progress);
    if (patch.status !== undefined) {
      const wasTerminal = TERMINAL_STATUSES.has(node.status);
      node.status = patch.status;
      if (patch.status === 'running' && !node.startedAt) {
        node.startedAt = new Date().toISOString();
      }
      if (TERMINAL_STATUSES.has(patch.status)) {
        if (!node.finishedAt) node.finishedAt = new Date().toISOString();
        if (patch.status === 'done') node.progress = 100;
      } else if (wasTerminal && !TERMINAL_STATUSES.has(patch.status)) {
        // Mo lai task da ket thuc (vd retry): xoa finishedAt.
        node.finishedAt = undefined;
      }
    }
    this.touch();
    return true;
  }

  /** Tien ich: danh dau node xong (progress 100) + log tom tat. */
  completeTask(id: string, summary?: string): boolean {
    const patch: CodingV4UpdateTaskPatch = { status: 'done', progress: 100 };
    if (summary !== undefined) patch.logLine = summary;
    return this.updateTask(id, patch);
  }

  /** Tien ich: danh dau node loi + ly do. */
  failTask(id: string, error: string): boolean {
    return this.updateTask(id, { status: 'failed', error });
  }

  /** Tien ich: huy node + ly do. */
  cancelTask(id: string, reason?: string): boolean {
    const patch: CodingV4UpdateTaskPatch = { status: 'cancelled' };
    if (reason !== undefined) patch.error = reason;
    return this.updateTask(id, patch);
  }

  /** Bat dau chay root (status running) — goi khi agent bat dau lam. */
  startRoot(): void {
    this.updateTask(this.rootNode.id, { status: 'running', progress: 0 });
  }

  /** Danh sach phang (pre-order) de UI render hang loat. */
  flatten(): CodingV4TaskNode[] {
    const out: CodingV4TaskNode[] = [];
    flattenInto(this.rootNode, out);
    return out;
  }

  countsByStatus(): Record<CodingV4TaskStatus, number> {
    const counts: Record<CodingV4TaskStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    countStatuses(this.rootNode, counts);
    return counts;
  }

  /** Tien do tong: trung binh tien do cac la (0-100). */
  overallProgress(): number {
    const leaves: CodingV4TaskNode[] = [];
    collectLeaves(this.rootNode, leaves);
    if (leaves.length === 0) return clampProgress(this.rootNode.progress);
    const sum = leaves.reduce((acc, leaf) => acc + clampProgress(leaf.progress), 0);
    return Math.round(sum / leaves.length);
  }

  /** Snapshot bat bien (clone) de gui cho UI / luu log. */
  snapshot(): CodingV4TaskTreeSnapshot {
    const counts = this.countsByStatus();
    const totalNodes = this.flatten().length;
    return {
      version: this.versionCounter,
      root: cloneNode(this.rootNode),
      counts,
      totalNodes,
      overallProgress: this.overallProgress(),
      updatedAt: this.updatedAtValue,
    };
  }

  /**
   * Node da doi giua 2 snapshot: so status, progress hien thi, so
   * dong log va tieu de. Tra id cac node khac nhau (ke ca node moi).
   * UI dung de chi cap nhat cac dong doi thay vi render lai ca cay.
   */
  static diffSnapshots(
    prev: CodingV4TaskTreeSnapshot,
    next: CodingV4TaskTreeSnapshot,
  ): string[] {
    const prevNodes = new Map<string, CodingV4TaskNode>();
    const nextNodes = new Map<string, CodingV4TaskNode>();
    const collect = (node: CodingV4TaskNode, into: Map<string, CodingV4TaskNode>): void => {
      into.set(node.id, node);
      for (const child of node.children) collect(child, into);
    };
    collect(prev.root, prevNodes);
    collect(next.root, nextNodes);
    const changed: string[] = [];
    for (const [id, node] of nextNodes) {
      const old = prevNodes.get(id);
      if (!old) {
        changed.push(id);
        continue;
      }
      if (
        old.status !== node.status ||
        codingV4NodeProgress(old) !== codingV4NodeProgress(node) ||
        old.log.length !== node.log.length ||
        old.title !== node.title ||
        old.tokensUsed !== node.tokensUsed
      ) {
        changed.push(id);
      }
    }
    return changed.sort();
  }

  /** Render cay dang text (thut le) — chat UI ban text / log debug. */
  renderText(): string {
    const lines: string[] = [];
    const walk = (node: CodingV4TaskNode, depth: number): void => {
      const indent = '  '.repeat(depth);
      const icon = CODING_V4_STATUS_ICONS[node.status];
      const pct = codingV4NodeProgress(node);
      const extra: string[] = [];
      if (node.model) extra.push(node.model);
      if (node.tokensUsed !== undefined) extra.push(`${node.tokensUsed} tokens`);
      if (node.error && node.status === 'failed') extra.push(`loi: ${node.error}`);
      lines.push(
        `${indent}${icon} ${node.title} — ${pct}% [${node.status}]${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`,
      );
      const tail = node.log.slice(-3);
      for (const line of tail) lines.push(`${indent}    | ${line}`);
      if (node.logTruncated > 0) {
        lines.push(`${indent}    | ... (${node.logTruncated} dong log cu da cat)`);
      }
      for (const child of node.children) walk(child, depth + 1);
    };
    walk(this.rootNode, 0);
    lines.push(`Tien do chung: ${this.overallProgress()}% — ${this.flatten().length} task.`);
    return lines.join('\n');
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  /** Khoi phuc cay tu snapshot da serialize (version duoc giu nguyen). */
  static parse(text: string): CodingV4TaskTree {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (e) {
      throw new Error(`Snapshot cay task v4 JSON hong: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Snapshot cay task v4 khong phai object JSON.');
    }
    const snap = parsed as CodingV4TaskTreeSnapshot;
    if (!snap.root || typeof snap.root.id !== 'string' || typeof snap.root.title !== 'string') {
      throw new Error('Snapshot cay task v4 thieu root.');
    }
    const tree = new CodingV4TaskTree(snap.root.title, { rootId: snap.root.id });
    tree.rootNode = cloneNode(snap.root);
    tree.versionCounter = typeof snap.version === 'number' ? snap.version : 0;
    tree.updatedAtValue = typeof snap.updatedAt === 'string' ? snap.updatedAt : new Date().toISOString();
    // Dem lai counter de id moi khong dung id cu.
    let max = 0;
    for (const node of tree.flatten()) {
      const m = /^task-(\d+)$/.exec(node.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    tree.counter = max + 1;
    return tree;
  }
}
