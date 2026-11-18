/**
 * Coding agent v12 — sub-agent task visualizer v2 (realtime).
 *
 * Nối visualizer v4 (cây task pure data + version + diff + render
 * text): v2 giữ nguyên mô hình cây đó và thêm 3 thứ mà v4 chưa có:
 *
 *   1. Event stream realtime: `subscribe(listener)` nhận event mỗi
 *      lần cây đổi (`node-added` / `node-updated` / `node-removed` /
 *      `tree-reset`) kèm snapshot mới — UI chỉ cần subscribe một lần
 *      là render live, không cần poll; `unsubscribe` để dọn.
 *   2. Node giàu hơn: file đang sửa (`editingFile`), file đã sửa
 *      (`editedFiles`), token + cost ước lượng theo từng node, trạng
 *      thái mới `blocked` (đang chờ edit khác) và `waiting` (đang
 *      chờ model/lượt) — để UI hiện đúng vì sao một sub-agent đứng
 *      yên thay vì chỉ thấy `pending`.
 *   3. Aggregate đúng: token/cost tổng chỉ cộng node LÁ (không đếm
 *      trùng con vào cha như cách cộng naive), progress tổng vẫn là
 *      trung bình các lá như v4; `diffSince(prevSnapshot)` cho UI
 *      chỉ cập nhật dòng đổi.
 *
 * Module thuần (không fs, không gọi LLM): host cập nhật cây khi
 * sub-agent chạy; listener được gọi đồng bộ ngay khi đổi. Giới hạn
 * trung thực: tiến độ vẫn là con số caller báo; cây sống trong bộ
 * nhớ — muốn bền vững thì serialize ra đĩa (host tự làm).
 */

import { CodingV12Error } from './types';
import type {
  V12TaskNode,
  V12TaskStatus,
  V12TaskTreeSnapshot,
  V12VisualizerEvent,
  V12VisualizerListener,
} from './types';

/** Các trạng thái hợp lệ của node v12. */
export const V12_TASK_STATUSES: V12TaskStatus[] = ['pending', 'running', 'done', 'failed', 'cancelled', 'blocked', 'waiting'];

/** Số dòng log tối đa giữ mỗi node (mặc định). */
export const V12_DEFAULT_MAX_LOG_LINES = 50;

/** Biểu tượng text cho từng trạng thái (dùng trong renderText). */
export const V12_STATUS_ICONS: Record<V12TaskStatus, string> = {
  pending: '[..]',
  running: '[>>]',
  done: '[OK]',
  failed: '[!!]',
  cancelled: '[--]',
  blocked: '[##]',
  waiting: '[~~]',
};

/** Trạng thái kết thúc (không chạy nữa). */
export function v12IsTerminalStatus(status: V12TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

export interface V12AddTaskOptions {
  detail?: string;
  model?: string;
  /** Id tự chọn; mặc định sinh `task-<n>`. */
  id?: string;
  /** File node này sẽ sửa ngay từ đầu (nếu biết). */
  editingFile?: string;
}

export interface V12UpdateTaskPatch {
  status?: V12TaskStatus;
  progress?: number;
  /** Thêm 1 dòng log (bị cắt khi vượt cap). */
  logLine?: string;
  model?: string;
  tokensUsed?: number;
  /** Cộng thêm cost ước lượng (USD). */
  costUsdDelta?: number;
  /** File đang sửa (ghi đè). */
  editingFile?: string | null;
  /** File vừa sửa xong (thêm vào editedFiles, xóa editingFile nếu trùng). */
  finishedFile?: string;
  error?: string;
}

function cloneNode(node: V12TaskNode): V12TaskNode {
  return {
    ...node,
    log: [...node.log],
    editedFiles: [...node.editedFiles],
    children: node.children.map(cloneNode),
  };
}

function countNodes(node: V12TaskNode, counts: Record<V12TaskStatus, number>): void {
  counts[node.status] += 1;
  for (const child of node.children) countNodes(child, counts);
}

function leafProgress(node: V12TaskNode, leaves: number[]): void {
  if (node.children.length === 0) {
    leaves.push(node.progress);
    return;
  }
  for (const child of node.children) leafProgress(child, leaves);
}

function leafTokens(node: V12TaskNode, acc: { tokens: number; cost: number; costKnown: boolean }): void {
  if (node.children.length === 0) {
    acc.tokens += node.tokensUsed;
    if (node.costUsd !== null) {
      acc.cost += node.costUsd;
      acc.costKnown = true;
    }
    return;
  }
  for (const child of node.children) leafTokens(child, acc);
}

/**
 * Cây sub-agent v2: root + map id → node, version tăng mỗi lần đổi,
 * listener realtime nhận event + snapshot mới.
 */
export class V12TaskVisualizer {
  private root: V12TaskNode;
  private version = 0;
  private counter = 0;
  private readonly maxLogLines: number;
  private readonly listeners = new Set<V12VisualizerListener>();
  private readonly index = new Map<string, V12TaskNode>();

  constructor(rootTitle: string, options?: { maxLogLines?: number; rootId?: string }) {
    this.maxLogLines = options?.maxLogLines ?? V12_DEFAULT_MAX_LOG_LINES;
    const now = new Date().toISOString();
    this.root = {
      id: options?.rootId ?? 'root',
      parentId: null,
      title: rootTitle,
      status: 'running',
      progress: 0,
      log: [],
      logTruncated: 0,
      tokensUsed: 0,
      costUsd: null,
      editedFiles: [],
      startedAt: now,
      children: [],
    };
    this.index.set(this.root.id, this.root);
  }

  /** Đăng ký nhận event realtime; trả hàm hủy đăng ký. */
  subscribe(listener: V12VisualizerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Số listener đang đăng ký. */
  listenerCount(): number {
    return this.listeners.size;
  }

  private emit(kind: V12VisualizerEvent['kind'], nodeId: string | null): void {
    this.version += 1;
    const snapshot = this.snapshot();
    const event: V12VisualizerEvent = { kind, nodeId, version: this.version, at: new Date().toISOString() };
    for (const listener of [...this.listeners]) {
      try {
        listener(event, snapshot);
      } catch {
        // Một listener lỗi không được làm chết cây hay các listener khác.
      }
    }
  }

  /** Snapshot hiện tại (deep copy, version hiện tại — không tăng version). */
  snapshot(): V12TaskTreeSnapshot {
    const counts: Record<V12TaskStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      blocked: 0,
      waiting: 0,
    };
    countNodes(this.root, counts);
    const leaves: number[] = [];
    leafProgress(this.root, leaves);
    const overallProgress = leaves.length === 0 ? this.root.progress : Math.round(leaves.reduce((a, b) => a + b, 0) / leaves.length);
    const acc = { tokens: 0, cost: 0, costKnown: false };
    leafTokens(this.root, acc);
    let totalNodes = 0;
    for (const n of Object.values(counts)) totalNodes += n;
    return {
      version: this.version,
      root: cloneNode(this.root),
      counts,
      totalNodes,
      overallProgress,
      totalTokens: acc.tokens,
      totalCostUsd: acc.costKnown ? acc.cost : null,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Tìm node theo id (throw khi không có). */
  getNode(id: string): V12TaskNode {
    const node = this.index.get(id);
    if (!node) throw new CodingV12Error('visualizer-node-not-found', `Visualizer v12: không có node \"${id}\".`);
    return node;
  }

  /** Thêm node con vào node cha (mặc định cha = root). */
  addTask(parentId: string | null, title: string, options: V12AddTaskOptions = {}): V12TaskNode {
    const parent = parentId === null ? this.root : this.index.get(parentId);
    if (!parent) throw new CodingV12Error('visualizer-parent-not-found', `Visualizer v12: không có node cha \"${parentId}\".`);
    if (typeof title !== 'string' || title.trim() === '') {
      throw new CodingV12Error('visualizer-node-not-found', 'Visualizer v12: tiêu đề task không được rỗng.');
    }
    this.counter += 1;
    const id = options.id ?? `task-${this.counter}`;
    if (this.index.has(id)) {
      throw new CodingV12Error('visualizer-node-not-found', `Visualizer v12: id node \"${id}\" đã tồn tại.`);
    }
    const node: V12TaskNode = {
      id,
      parentId: parent.id,
      title: title.trim(),
      detail: options.detail,
      status: 'pending',
      progress: 0,
      log: [],
      logTruncated: 0,
      model: options.model,
      tokensUsed: 0,
      costUsd: null,
      editingFile: options.editingFile,
      editedFiles: [],
      children: [],
    };
    parent.children.push(node);
    this.index.set(id, node);
    this.emit('node-added', id);
    return node;
  }

  /** Cập nhật một node (status/progress/log/token/file…). */
  updateTask(id: string, patch: V12UpdateTaskPatch): V12TaskNode {
    const node = this.getNode(id);
    if (patch.status !== undefined) {
      if (!V12_TASK_STATUSES.includes(patch.status)) {
        throw new CodingV12Error('visualizer-node-not-found', `Visualizer v12: trạng thái \"${patch.status}\" không hợp lệ.`);
      }
      node.status = patch.status;
      const now = new Date().toISOString();
      if (patch.status === 'running' && !node.startedAt) node.startedAt = now;
      if (v12IsTerminalStatus(patch.status) && !node.finishedAt) node.finishedAt = now;
    }
    if (patch.progress !== undefined) {
      node.progress = Math.max(0, Math.min(100, Math.round(patch.progress)));
    }
    if (patch.logLine !== undefined) {
      node.log.push(patch.logLine);
      while (node.log.length > this.maxLogLines) {
        node.log.shift();
        node.logTruncated += 1;
      }
    }
    if (patch.model !== undefined) node.model = patch.model;
    if (patch.tokensUsed !== undefined) node.tokensUsed = Math.max(0, Math.floor(patch.tokensUsed));
    if (patch.costUsdDelta !== undefined) {
      node.costUsd = (node.costUsd ?? 0) + patch.costUsdDelta;
    }
    if (patch.editingFile !== undefined) {
      node.editingFile = patch.editingFile === null ? undefined : patch.editingFile;
    }
    if (patch.finishedFile !== undefined) {
      if (!node.editedFiles.includes(patch.finishedFile)) node.editedFiles.push(patch.finishedFile);
      if (node.editingFile === patch.finishedFile) node.editingFile = undefined;
    }
    if (patch.error !== undefined) node.error = patch.error;
    this.emit('node-updated', id);
    return node;
  }

  /** Xóa một node (cả cây con của nó) — root không xóa được. */
  removeTask(id: string): void {
    if (id === this.root.id) {
      throw new CodingV12Error('visualizer-node-not-found', 'Visualizer v12: không xóa được node root.');
    }
    const node = this.getNode(id);
    const parent = node.parentId ? this.index.get(node.parentId) : null;
    if (parent) parent.children = parent.children.filter((c) => c.id !== id);
    const drop = (n: V12TaskNode): void => {
      this.index.delete(n.id);
      for (const c of n.children) drop(c);
    };
    drop(node);
    this.emit('node-removed', id);
  }

  /** Reset toàn bộ cây về root mới (giữ listener). */
  reset(rootTitle: string): void {
    this.index.clear();
    this.counter = 0;
    const now = new Date().toISOString();
    this.root = {
      id: 'root',
      parentId: null,
      title: rootTitle,
      status: 'running',
      progress: 0,
      log: [],
      logTruncated: 0,
      tokensUsed: 0,
      costUsd: null,
      editedFiles: [],
      startedAt: now,
      children: [],
    };
    this.index.set(this.root.id, this.root);
    this.emit('tree-reset', null);
  }

  /** Serialize cây (để host lưu đĩa). */
  serialize(): string {
    return JSON.stringify(this.snapshot());
  }
}

/** Khôi phục visualizer từ snapshot đã serialize (listener phải đăng ký lại). */
export function v12VisualizerFromSnapshot(json: string): V12TaskVisualizer {
  let parsed: V12TaskTreeSnapshot;
  try {
    parsed = JSON.parse(json) as V12TaskTreeSnapshot;
  } catch {
    throw new CodingV12Error('visualizer-node-not-found', 'Visualizer v12: snapshot JSON không hợp lệ.');
  }
  if (!parsed || !parsed.root || typeof parsed.root.title !== 'string') {
    throw new CodingV12Error('visualizer-node-not-found', 'Visualizer v12: snapshot thiếu root.');
  }
  const viz = new V12TaskVisualizer(parsed.root.title, { rootId: parsed.root.id });
  const restore = (node: V12TaskNode, parentId: string | null): void => {
    const copy: V12TaskNode = { ...node, log: [...node.log], editedFiles: [...node.editedFiles], children: [] };
    copy.parentId = parentId;
    // Ghi đè root đã tạo sẵn, các node còn lại add qua index nội bộ bằng cách chèn trực tiếp.
    (viz as unknown as { index: Map<string, V12TaskNode> }).index.set(copy.id, copy);
    if (parentId !== null) {
      const parent = (viz as unknown as { index: Map<string, V12TaskNode> }).index.get(parentId);
      parent?.children.push(copy);
    } else {
      (viz as unknown as { root: V12TaskNode }).root = copy;
    }
    for (const child of node.children) restore(child, copy.id);
  };
  // Xóa root mặc định khỏi index rồi restore toàn bộ từ snapshot.
  (viz as unknown as { index: Map<string, V12TaskNode> }).index.clear();
  restore(parsed.root, null);
  return viz;
}

/**
 * Diff 2 snapshot: id các node đã đổi (trạng thái / tiến độ / số dòng
 * log / file đang sửa / token) — UI chỉ cập nhật các dòng đó.
 */
export function v12DiffSnapshots(prev: V12TaskTreeSnapshot, next: V12TaskTreeSnapshot): string[] {
  const flatten = (node: V12TaskNode, out: Map<string, V12TaskNode>): void => {
    out.set(node.id, node);
    for (const c of node.children) flatten(c, out);
  };
  const prevMap = new Map<string, V12TaskNode>();
  const nextMap = new Map<string, V12TaskNode>();
  flatten(prev.root, prevMap);
  flatten(next.root, nextMap);
  const changed: string[] = [];
  for (const [id, nextNode] of nextMap) {
    const prevNode = prevMap.get(id);
    if (!prevNode) {
      changed.push(id);
      continue;
    }
    if (
      prevNode.status !== nextNode.status ||
      prevNode.progress !== nextNode.progress ||
      prevNode.log.length !== nextNode.log.length ||
      prevNode.logTruncated !== nextNode.logTruncated ||
      prevNode.editingFile !== nextNode.editingFile ||
      prevNode.editedFiles.length !== nextNode.editedFiles.length ||
      prevNode.tokensUsed !== nextNode.tokensUsed ||
      prevNode.model !== nextNode.model
    ) {
      changed.push(id);
    }
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) changed.push(id);
  }
  return changed.sort();
}

/** Render cây thành text thụt lề (chat UI chưa có component React). */
export function renderV12TaskTreeText(snapshot: V12TaskTreeSnapshot): string {
  const lines: string[] = [
    `Sub-agent v12: ${snapshot.totalNodes} node, tiến độ ${snapshot.overallProgress}%, ${snapshot.totalTokens} token${snapshot.totalCostUsd !== null ? `, ~$${snapshot.totalCostUsd.toFixed(4)}` : ''}.`,
  ];
  const walk = (node: V12TaskNode, depth: number): void => {
    const indent = '  '.repeat(depth);
    const extra: string[] = [];
    if (node.model) extra.push(node.model);
    if (node.editingFile) extra.push(`đang sửa ${node.editingFile}`);
    if (node.editedFiles.length > 0) extra.push(`đã sửa ${node.editedFiles.length} file`);
    if (node.tokensUsed > 0) extra.push(`${node.tokensUsed} token`);
    if (node.error) extra.push(`lỗi: ${node.error}`);
    lines.push(
      `${indent}${V12_STATUS_ICONS[node.status]} ${node.title} (${node.progress}%)${extra.length > 0 ? ` — ${extra.join(' · ')}` : ''}`,
    );
    for (const logLine of node.log.slice(-3)) lines.push(`${indent}    ${logLine}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(snapshot.root, 0);
  return lines.join('\n');
}
