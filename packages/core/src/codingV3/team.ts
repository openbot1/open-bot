/**
 * Manager / explorer / worker cho coding agent v3 (v1.10, Đội T4).
 *
 * Ý tưởng học từ Codex CLI (manager + explorer/worker, giới hạn thread
 * cấu hình được) và Claude Code Agent Teams (shared task list + claiming):
 * chỉ học ý tưởng, tự thiết kế và viết lại hoàn toàn — KHÔNG đọc, KHÔNG
 * copy code/text/tài sản của repo nào.
 *
 *   - Explorer: đọc repo (qua repo map v2/v3 + hàm đọc file do caller
 *     cấp) rồi trả "brief": file liên quan, symbol nổi bật, rủi ro —
 *     không sửa code.
 *   - Worker: nhận một subtask + spec, chạy executor do caller cấp
 *     (mặc định: patch executor áp dụng edit tạo/ghi/sửa/xoá file
 *     trong root đã khoá) rồi trả kết quả + file đã đổi.
 *   - Manager: chia task thành subtask, explorer đi trước để định
 *     hướng, worker chạy song song dưới semaphore (giới hạn thread
 *     cấu hình được), claim subtask nguyên tử (một worker không nhận
 *     trùng việc), tổng hợp kết quả.
 *
 * Module này không gọi LLM: "executor" và "splitter" là hàm caller
 * cấp (host nối model thật, test nối fake). Nhờ đó toàn bộ pipeline
 * test được mà không cần key hay mạng.
 *
 * Giới hạn trung thực:
 *   - claiming nguyên tử trong một process (Map + semaphore); không
 *     phải file-lock đa process như Agent Teams v2 (T3) — hai manager
 *     khác process có thể nhận trùng việc nếu cùng chạy một lúc.
 *   - patch executor chỉ sửa file text trong root, chặn path traversal
 *     (`..` và đường dẫn tuyệt đối thoát root); không chạy lệnh shell.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodingV2Graph, CodingV2FileEntry } from '../codingV2/repoMapGraph';
import { queryCodingV2Graph } from '../codingV2/repoMapGraph';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

export type CodingV3TaskStatus = 'pending' | 'claimed' | 'running' | 'done' | 'failed' | 'skipped';

export interface CodingV3Task {
  id: string;
  title: string;
  /** Mô tả việc cần làm (spec cho worker). */
  spec: string;
  /** Gợi ý file liên quan (đường dẫn repo-relative). */
  files?: string[];
  /** Ước tính độ khó 1-5 (router dùng để chọn model). */
  difficulty?: number;
  /** Edit áp dụng trực tiếp (patch executor) — khi có, splitter không chia nhỏ. */
  edits?: CodingV3Edit[];
}

export interface CodingV3SubTask extends CodingV3Task {
  parentId: string;
  status: CodingV3TaskStatus;
  claimedBy?: string;
  /** Lý do fail/skip (khi có). */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type CodingV3EditKind = 'create' | 'write' | 'edit' | 'delete';

export interface CodingV3Edit {
  /** Đường dẫn repo-relative (trong root). */
  path: string;
  kind: CodingV3EditKind;
  /** Nội dung mới (create/write). */
  content?: string;
  /** Text cũ cần khớp đúng 1 lần (edit). */
  oldText?: string;
  /** Text thay thế (edit). */
  newText?: string;
}

export interface CodingV3FileChange {
  path: string;
  kind: CodingV3EditKind;
  linesAdded: number;
  linesRemoved: number;
}

export interface CodingV3WorkerResult {
  subTaskId: string;
  workerId: string;
  success: boolean;
  summary: string;
  filesChanged: CodingV3FileChange[];
  /** Lỗi khi success = false. */
  error?: string;
  durationMs: number;
}

/** Executor của worker: nhận subtask, trả kết quả (host nối model thật). */
export type CodingV3WorkerExecutor = (
  subTask: CodingV3SubTask,
  ctx: { workerId: string; rootDir: string },
) => Promise<CodingV3WorkerResult>;

/** Splitter của manager: chia task thành subtask (mặc định: theo file gợi ý). */
export type CodingV3TaskSplitter = (task: CodingV3Task) => CodingV3SubTask[];

/** Số thread song song tối đa mặc định (học Codex: cấu hình được). */
export const CODING_V3_DEFAULT_MAX_THREADS = 4;
/** Trần thread song song (chống cấu hình vô lý). */
export const CODING_V3_MAX_THREADS_CAP = 20;
/** Trần edit mỗi worker (chống một subtask phá nát repo). */
export const CODING_V3_MAX_EDITS_PER_WORKER = 50;
/** Trần dòng thay đổi mỗi file trong patch executor. */
export const CODING_V3_MAX_LINES_PER_FILE_CHANGE = 2000;

// ---------------------------------------------------------------------------
// Semaphore (giới hạn thread song song)
// ---------------------------------------------------------------------------

export class CodingV3Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  private maxObserved = 0;

  constructor(
    readonly max: number,
  ) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`max threads phải là số nguyên >= 1, nhận ${String(max)}.`);
    }
  }

  get current(): number {
    return this.running;
  }

  get maxObservedConcurrency(): number {
    return this.maxObserved;
  }

  async acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running += 1;
      this.maxObserved = Math.max(this.maxObserved, this.running);
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running += 1;
    this.maxObserved = Math.max(this.maxObserved, this.running);
    return () => this.release();
  }

  private release(): void {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

export interface CodingV3ExplorerBrief {
  query: string;
  /** File liên quan nhất (theo repo map) + symbol nổi bật. */
  relevantFiles: Array<{
    relPath: string;
    score: number;
    match: 'seed' | 'related';
    topSymbols: Array<{ name: string; qualifiedName: string; kind: string; line: number }>;
  }>;
  /** File gợi ý đã đọc được (đường dẫn + số dòng + 5 dòng đầu). */
  filesRead: Array<{ relPath: string; lines: number; preview: string }>;
  /** File gợi ý không đọc được (không tồn tại / ngoài root). */
  unreadableFiles: string[];
  risks: string[];
  generatedAt: string;
}

export interface CodingV3ExplorerOptions {
  limit?: number;
  /** Số file gợi ý đọc thử (mặc định 5). */
  maxFilesToRead?: number;
}

/**
 * Explorer: truy vấn repo map v2/v3 rồi đọc thử file gợi ý.
 * `readFile` do caller cấp (mặc định đọc từ đĩa trong root, chặn
 * path traversal) — explorer không bao giờ sửa file.
 */
export class CodingV3Explorer {
  constructor(
    private readonly graph: CodingV2Graph,
    private readonly files: CodingV2FileEntry[],
    private readonly rootDir?: string,
  ) {}

  brief(
    query: string,
    options: CodingV3ExplorerOptions = {},
    readFile?: (relPath: string) => string | null,
  ): CodingV3ExplorerBrief {
    const limit = Math.max(1, Math.floor(options.limit ?? 10));
    const maxFilesToRead = Math.max(0, Math.floor(options.maxFilesToRead ?? 5));
    const result = queryCodingV2Graph(this.graph, this.files, query, { limit, topSymbolsPerFile: 3 });
    const risks: string[] = [];
    if (result.fellBackToGlobal) {
      risks.push(`Truy vấn "${query}" không khớp file/symbol nào — brief dùng xếp hạng toàn cục, có thể lạc đề.`);
    }
    if (result.files.length === 0) risks.push('Repo map rỗng — chưa build map hoặc repo không có file quét được.');

    const reader =
      readFile ??
      ((relPath: string): string | null => {
        if (!this.rootDir) return null;
        const resolved = path.resolve(this.rootDir, relPath);
        if (resolved !== this.rootDir && !resolved.startsWith(this.rootDir + path.sep)) return null;
        try {
          return fs.readFileSync(resolved, 'utf8');
        } catch {
          return null;
        }
      });

    const filesRead: CodingV3ExplorerBrief['filesRead'] = [];
    const unreadableFiles: string[] = [];
    for (const hit of result.files.slice(0, maxFilesToRead)) {
      const content = reader(hit.relPath);
      if (content === null) {
        unreadableFiles.push(hit.relPath);
        continue;
      }
      const lines = content.split('\n');
      filesRead.push({
        relPath: hit.relPath,
        lines: lines.length,
        preview: lines.slice(0, 5).join('\n').slice(0, 500),
      });
    }
    if (unreadableFiles.length > 0) {
      risks.push(`${unreadableFiles.length} file gợi ý không đọc được: ${unreadableFiles.slice(0, 3).join(', ')}`);
    }
    return {
      query,
      relevantFiles: result.files.map((f) => ({
        relPath: f.relPath,
        score: f.score,
        match: f.match,
        topSymbols: f.topSymbols.map((s) => ({
          name: s.name,
          qualifiedName: s.qualifiedName,
          kind: s.kind,
          line: s.line,
        })),
      })),
      filesRead,
      unreadableFiles,
      risks,
      generatedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Patch executor (worker mặc định): áp dụng edit vào file trong root
// ---------------------------------------------------------------------------

/** Resolve đường dẫn edit vào trong root; trả null khi thoát root. */
export function resolveCodingV3EditPath(rootDir: string, relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath.trim() === '') return null;
  if (path.isAbsolute(relPath)) return null;
  const resolved = path.resolve(rootDir, relPath);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) return null;
  return resolved;
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

/**
 * Áp dụng một edit vào đĩa (trong root). Trả FileChange hoặc throw
 * với lý do rõ ràng (file không tồn tại, oldText không khớp/khớp
 * nhiều lần, content thiếu...). Không chạy shell, không ghi ngoài root.
 */
export function applyCodingV3Edit(rootDir: string, edit: CodingV3Edit): CodingV3FileChange {
  const resolved = resolveCodingV3EditPath(rootDir, edit.path);
  if (resolved === null) {
    throw new Error(`Đường dẫn "${edit.path}" thoát khỏi root — từ chối.`);
  }
  if (edit.kind === 'delete') {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Không xoá được "${edit.path}": file không tồn tại.`);
    }
    const before = fs.readFileSync(resolved, 'utf8');
    fs.unlinkSync(resolved);
    return { path: edit.path, kind: 'delete', linesAdded: 0, linesRemoved: countLines(before) };
  }
  if (edit.kind === 'create') {
    if (fs.existsSync(resolved)) {
      throw new Error(`Không tạo được "${edit.path}": file đã tồn tại (dùng write để ghi đè).`);
    }
    if (typeof edit.content !== 'string') {
      throw new Error(`Edit create "${edit.path}" thiếu content.`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, edit.content, 'utf8');
    return { path: edit.path, kind: 'create', linesAdded: countLines(edit.content), linesRemoved: 0 };
  }
  if (edit.kind === 'write') {
    if (typeof edit.content !== 'string') {
      throw new Error(`Edit write "${edit.path}" thiếu content.`);
    }
    const before = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, edit.content, 'utf8');
    return {
      path: edit.path,
      kind: 'write',
      linesAdded: countLines(edit.content),
      linesRemoved: countLines(before),
    };
  }
  // edit: thay đúng 1 lần xuất hiện của oldText.
  if (typeof edit.oldText !== 'string' || edit.oldText === '') {
    throw new Error(`Edit edit "${edit.path}" thiếu oldText.`);
  }
  if (typeof edit.newText !== 'string') {
    throw new Error(`Edit edit "${edit.path}" thiếu newText.`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Không sửa được "${edit.path}": file không tồn tại.`);
  }
  const before = fs.readFileSync(resolved, 'utf8');
  const first = before.indexOf(edit.oldText);
  if (first === -1) {
    throw new Error(`Edit "${edit.path}": oldText không khớp chỗ nào trong file.`);
  }
  if (before.indexOf(edit.oldText, first + 1) !== -1) {
    throw new Error(`Edit "${edit.path}": oldText khớp nhiều chỗ — phải hẹp lại để chỉ khớp 1 chỗ.`);
  }
  const after = before.slice(0, first) + edit.newText + before.slice(first + edit.oldText.length);
  if (Math.abs(countLines(after) - countLines(before)) > CODING_V3_MAX_LINES_PER_FILE_CHANGE) {
    throw new Error(`Edit "${edit.path}": thay đổi vượt trần ${CODING_V3_MAX_LINES_PER_FILE_CHANGE} dòng.`);
  }
  fs.writeFileSync(resolved, after, 'utf8');
  return {
    path: edit.path,
    kind: 'edit',
    linesAdded: countLines(edit.newText),
    linesRemoved: countLines(edit.oldText),
  };
}

/**
 * Patch executor: một subtask mang danh sách edit trong `spec` dạng
 * JSON (`{ "edits": [...] }`) hoặc trong trường `edits` mở rộng của
 * subtask. Áp dụng tuần tự, dừng ở edit lỗi đầu tiên, báo rõ.
 * (Host nối model thật sẽ tự tạo edit từ spec tự do; executor này
 * là tầng áp dụng, không phải model.)
 */
export function createCodingV3PatchExecutor(): CodingV3WorkerExecutor {
  return async (subTask, { workerId, rootDir }) => {
    const startedAt = Date.now();
    let edits: CodingV3Edit[] = [];
    if (Array.isArray(subTask.edits)) {
      edits = subTask.edits;
    } else {
      try {
        const parsed = JSON.parse(subTask.spec) as { edits?: unknown };
        if (Array.isArray(parsed.edits)) edits = parsed.edits as CodingV3Edit[];
      } catch {
        // spec tự do (không phải JSON edits): không có gì để áp dụng.
      }
    }
    if (edits.length === 0) {
      return {
        subTaskId: subTask.id,
        workerId,
        success: false,
        summary: 'Subtask không mang edit nào (spec phải chứa JSON { "edits": [...] } hoặc trường edits).',
        filesChanged: [],
        error: 'no-edits',
        durationMs: Date.now() - startedAt,
      };
    }
    if (edits.length > CODING_V3_MAX_EDITS_PER_WORKER) {
      return {
        subTaskId: subTask.id,
        workerId,
        success: false,
        summary: `Subtask có ${edits.length} edits, vượt trần ${CODING_V3_MAX_EDITS_PER_WORKER}.`,
        filesChanged: [],
        error: 'too-many-edits',
        durationMs: Date.now() - startedAt,
      };
    }
    const filesChanged: CodingV3FileChange[] = [];
    try {
      for (const edit of edits) {
        filesChanged.push(applyCodingV3Edit(rootDir, edit));
      }
    } catch (e) {
      return {
        subTaskId: subTask.id,
        workerId,
        success: false,
        summary: `Worker ${workerId} dừng ở edit thứ ${filesChanged.length + 1}/${edits.length}: ${e instanceof Error ? e.message : String(e)}`,
        filesChanged,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      subTaskId: subTask.id,
      workerId,
      success: true,
      summary: `Worker ${workerId} áp dụng ${edits.length} edit(s) trên ${filesChanged.length} file.`,
      filesChanged,
      durationMs: Date.now() - startedAt,
    };
  };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface CodingV3ManagerOptions {
  /** Số worker chạy song song tối đa (mặc định 4, trần 20). */
  maxConcurrentThreads?: number;
  /** Executor worker (mặc định: patch executor). */
  executor?: CodingV3WorkerExecutor;
  /** Splitter (mặc định: chia theo file gợi ý, tối đa 1 subtask/file). */
  splitter?: CodingV3TaskSplitter;
  /** Explorer đi trước để brief (không bắt buộc). */
  explorer?: CodingV3Explorer | null;
  /** Root dir worker được sửa (patch executor cần). */
  rootDir?: string;
}

export interface CodingV3TeamRunResult {
  runId: string;
  taskId: string;
  taskTitle: string;
  status: 'done' | 'partial' | 'failed';
  subTasks: CodingV3SubTask[];
  results: CodingV3WorkerResult[];
  /** Số worker chạy song song cao nhất quan sát được. */
  maxConcurrencyObserved: number;
  maxConcurrentThreads: number;
  filesChanged: CodingV3FileChange[];
  /** Brief của explorer (khi có explorer). */
  explorerBrief?: CodingV3ExplorerBrief;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
}

export function defaultCodingV3Splitter(task: CodingV3Task): CodingV3SubTask[] {
  // Task mang sẵn edits: một subtask duy nhất áp dụng toàn bộ edits
  // (chia nhỏ sẽ áp dụng trùng edits ở nhiều worker).
  if (task.edits !== undefined && task.edits.length > 0) {
    return [
      {
        id: `${task.id}-1`,
        parentId: task.id,
        title: task.title,
        spec: task.spec,
        files: task.files ?? [],
        difficulty: task.difficulty,
        edits: task.edits,
        status: 'pending',
      },
    ];
  }
  const files = (task.files ?? []).filter((f) => typeof f === 'string' && f.trim() !== '');
  if (files.length === 0) {
    return [
      {
        id: `${task.id}-1`,
        parentId: task.id,
        title: task.title,
        spec: task.spec,
        files: [],
        difficulty: task.difficulty,
        status: 'pending',
      },
    ];
  }
  return files.map((file, i) => ({
    id: `${task.id}-${i + 1}`,
    parentId: task.id,
    title: `${task.title} — ${file}`,
    spec: `${task.spec}\n\nPhạm vi file: ${file}`,
    files: [file],
    difficulty: task.difficulty,
    status: 'pending' as CodingV3TaskStatus,
  }));
}

let teamRunCounter = 0;

/**
 * Manager: chia task, explorer brief trước (nếu có), chạy worker
 * song song dưới semaphore, claim nguyên tử từng subtask, tổng hợp.
 * Worker lỗi không dừng cả team — subtask đó failed, các subtask
 * khác vẫn chạy; status chung: done (tất cả ok) / partial (một phần
 * fail) / failed (tất cả fail hoặc không có subtask nào).
 */
export class CodingV3Manager {
  private readonly maxThreads: number;
  private readonly executor: CodingV3WorkerExecutor;
  private readonly splitter: CodingV3TaskSplitter;
  private readonly explorer: CodingV3Explorer | null;
  private readonly rootDir: string;

  constructor(options: CodingV3ManagerOptions = {}) {
    const wanted = Math.floor(options.maxConcurrentThreads ?? CODING_V3_DEFAULT_MAX_THREADS);
    if (!Number.isInteger(wanted) || wanted < 1) {
      throw new Error(`maxConcurrentThreads phải là số nguyên >= 1, nhận ${String(options.maxConcurrentThreads)}.`);
    }
    this.maxThreads = Math.min(wanted, CODING_V3_MAX_THREADS_CAP);
    this.executor = options.executor ?? createCodingV3PatchExecutor();
    this.splitter = options.splitter ?? defaultCodingV3Splitter;
    this.explorer = options.explorer ?? null;
    this.rootDir = options.rootDir ?? process.cwd();
  }

  get maxConcurrentThreads(): number {
    return this.maxThreads;
  }

  async run(task: CodingV3Task): Promise<CodingV3TeamRunResult> {
    const startedAt = Date.now();
    teamRunCounter += 1;
    const runId = `team-run-${teamRunCounter}-${startedAt}`;
    const subTasks = this.splitter(task);
    const explorerBrief = this.explorer
      ? this.explorer.brief(task.title, { limit: 10, maxFilesToRead: 5 })
      : undefined;

    const semaphore = new CodingV3Semaphore(this.maxThreads);
    const results: CodingV3WorkerResult[] = [];

    // Claim nguyên tử: mỗi subtask chỉ được một worker nhận (trong
    // process này, việc claim xảy ra đồng bộ trước khi worker chạy).
    const runOne = async (subTask: CodingV3SubTask, workerIndex: number): Promise<void> => {
      const workerId = `worker-${workerIndex + 1}`;
      if (subTask.status !== 'pending') return; // đã có worker khác claim.
      subTask.status = 'claimed';
      subTask.claimedBy = workerId;
      const release = await semaphore.acquire();
      try {
        subTask.status = 'running';
        subTask.startedAt = new Date().toISOString();
        const result = await this.executor(subTask, { workerId, rootDir: this.rootDir });
        subTask.status = result.success ? 'done' : 'failed';
        if (!result.success && result.error) subTask.error = result.error;
        subTask.finishedAt = new Date().toISOString();
        results.push(result);
      } catch (e) {
        subTask.status = 'failed';
        subTask.error = e instanceof Error ? e.message : String(e);
        subTask.finishedAt = new Date().toISOString();
        results.push({
          subTaskId: subTask.id,
          workerId,
          success: false,
          summary: `Worker ${workerId} crash: ${subTask.error}`,
          filesChanged: [],
          error: subTask.error,
          durationMs: 0,
        });
      } finally {
        release();
      }
    };

    await Promise.all(subTasks.map((subTask, i) => runOne(subTask, i)));

    const done = subTasks.filter((s) => s.status === 'done').length;
    const failed = subTasks.filter((s) => s.status === 'failed').length;
    const status: CodingV3TeamRunResult['status'] =
      subTasks.length === 0 || done === 0 ? 'failed' : failed === 0 ? 'done' : 'partial';
    const filesChanged = results.flatMap((r) => r.filesChanged);
    const finishedAt = Date.now();
    return {
      runId,
      taskId: task.id,
      taskTitle: task.title,
      status,
      subTasks,
      results,
      maxConcurrencyObserved: semaphore.maxObservedConcurrency,
      maxConcurrentThreads: this.maxThreads,
      filesChanged,
      explorerBrief,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      summary: `Team run ${runId}: ${done}/${subTasks.length} subtask(s) done, ${failed} failed, ${filesChanged.length} file change(s), max concurrency ${semaphore.maxObservedConcurrency}/${this.maxThreads}.`,
    };
  }
}
