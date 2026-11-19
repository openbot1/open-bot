/**
 * Memory v28 — git-backed block store (v1.44, Doi T1).
 *
 * Y tuong hoc tu Letta v0.16.7 MemFS (survey v144 muc 2, chi y
 * tuong, KHONG copy code/text/tai san): memory block la file co
 * version trong repo git rieng — history/diff/rollback co san tu
 * git. Tu thiet ke lai hoan toan cho open-bot, ke thua dinh dang
 * frontmatter cua MemFS-lite (v0.96) va guardrail scope system
 * cua gitProjection v7 (block `human`/`persona` chi user/he
 * thong sua, agent bi chan).
 *
 * Bo cuc trong workspace:
 *   <rootDir>/memory-v28/          <- repo git RIENG
 *     blocks/<label>.md            <- 1 file / 1 block, co frontmatter
 *     history.jsonl                <- log du phong khi may khong co git
 *     facts.jsonl                  <- fact bi-temporal (o invalidation.ts)
 *     acl.json / audit.jsonl       <- ACL + audit shared block
 *
 * File block `<label>.md`:
 *   ---
 *   label: human
 *   kind: human
 *   description: "..."
 *   scope: system
 *   readOnly: false
 *   ownerBotId: bot-a
 *   version: 3
 *   hash: <sha256 cua body>
 *   createdAt: "2026-11-19T..."
 *   updatedAt: "2026-11-19T..."
 *   ---
 *   <noi dung block>
 *
 * Moi lan ghi = 1 commit git (`[memory-v28] <label> v<n>: <message>`).
 * Rollback KHONG rewrite history: no dung cu duoc commit thanh
 * version moi. Archive = chuyen file sang `archived/` + commit.
 * Khi may khong co git: moi thao tac file van chay, lich su roi
 * ve `history.jsonl` (append-only, snapshot day du noi dung).
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  errV28,
  hashContentV28,
  isValidBlockLabelV28,
  isoAtV28,
  makeV28Id,
  normalizeBlockLabelV28,
  normalizeTextV28,
  okV28,
  parseIsoV28,
  V28_BLOCKS_DIR_NAME,
  V28_HISTORY_FILENAME,
  V28_LIMITS,
  V28_ROOT_DIR_NAME,
  type V28Block,
  type V28BlockMeta,
  type V28BlockVersion,
  type V28Result,
} from './types';

/** Block he thong — agent khong duoc sua (chi user/system). Ke thua v7. */
export const V28_SYSTEM_BLOCK_LABELS = ['human', 'persona'] as const;

/** Thu muc chua block da archive trong repo git v28. */
export const V28_ARCHIVED_DIR_NAME = 'archived';

/** Gioi han thoi gian cho moi lenh git (ms) — tranh treo may yeu. */
const GIT_TIMEOUT_MS = 15_000;

/** Mot muc lich su trong history.jsonl (fallback khong git). */
export interface V28HistoryEntry {
  label: string;
  version: number;
  hash: string;
  commit: string;
  author: string;
  message: string;
  createdAt: string;
  content: string;
}

/** Tuy chon khi ghi block. */
export interface V28WriteBlockOptions {
  kind?: V28Block['meta']['kind'];
  description?: string;
  scope?: V28Block['meta']['scope'];
  readOnly?: boolean;
  ownerBotId?: string;
  /** Actor thuc hien ghi: `user`, `system`, `agent:<botId>`, `sleep-agent`. */
  actor?: string;
  message?: string;
  /** Ghi de ngay ca khi noi dung khong doi (mac dinh: khong doi thi bo qua). */
  force?: boolean;
}

/** Tuy chon khoi tao GitBlockStore. */
export interface V28GitStoreOptions {
  /** Thu muc workspace; repo git dat tai `<rootDir>/memory-v28/`. */
  rootDir: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  /** Duong dan binary git (mac dinh `git`). */
  gitPath?: string;
}

/** Parse frontmatter toi gian (scalar JSON + list `- item`), ke thua MemFS-lite. */
export function parseV28Frontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { data: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text };
  const data: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    const listMatch = /^(\s*)- (.*)$/.exec(line);
    if (listMatch && currentListKey) {
      const raw = (listMatch[2] ?? '').trim();
      const arr = data[currentListKey];
      if (Array.isArray(arr)) arr.push(yamlScalarValueV28(raw));
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      currentListKey = null;
      continue;
    }
    const key = match[1] as string;
    const raw = (match[2] ?? '').trim();
    if (raw === '') {
      data[key] = [];
      currentListKey = key;
    } else {
      data[key] = yamlScalarValueV28(raw);
      currentListKey = null;
    }
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

function yamlScalarValueV28(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function yamlScalarV28(value: string | number | boolean): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

/** Ghep file block tu meta + body (frontmatter + noi dung). */
export function renderV28BlockFile(meta: V28BlockMeta, content: string): string {
  const lines = [
    '---',
    `label: ${yamlScalarV28(meta.label)}`,
    `kind: ${yamlScalarV28(meta.kind)}`,
    `description: ${yamlScalarV28(meta.description)}`,
    `scope: ${yamlScalarV28(meta.scope)}`,
    `readOnly: ${yamlScalarV28(meta.readOnly)}`,
    `ownerBotId: ${yamlScalarV28(meta.ownerBotId)}`,
    `version: ${meta.version}`,
    `hash: ${yamlScalarV28(meta.hash)}`,
    `commit: ${yamlScalarV28(meta.commit)}`,
    `createdAt: ${yamlScalarV28(meta.createdAt)}`,
    `updatedAt: ${yamlScalarV28(meta.updatedAt)}`,
    '---',
    content.endsWith('\n') ? content : `${content}\n`,
  ];
  return lines.join('\n');
}

/** Doc meta tu frontmatter cua file block (bo qua body). */
export function parseV28BlockMeta(text: string, fallbackLabel: string): V28BlockMeta | null {
  const { data, body } = parseV28Frontmatter(text);
  const label = typeof data.label === 'string' ? data.label : fallbackLabel;
  if (!isValidBlockLabelV28(label)) return null;
  const createdAt = typeof data.createdAt === 'string' ? data.createdAt : new Date(0).toISOString();
  const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : createdAt;
  return {
    label,
    kind: isV28BlockKind(data.kind) ? data.kind : 'custom',
    description: typeof data.description === 'string' ? data.description : '',
    scope: isV28BlockScope(data.scope) ? data.scope : 'user',
    readOnly: data.readOnly === true,
    ownerBotId: typeof data.ownerBotId === 'string' ? data.ownerBotId : '',
    version: typeof data.version === 'number' ? data.version : 1,
    hash: typeof data.hash === 'string' ? data.hash : hashContentV28(body),
    commit: typeof data.commit === 'string' ? data.commit : '',
    createdAt,
    updatedAt,
  };
}

function isV28BlockKind(value: unknown): value is V28BlockMeta['kind'] {
  return (
    value === 'human' ||
    value === 'persona' ||
    value === 'note' ||
    value === 'fact' ||
    value === 'shared' ||
    value === 'custom'
  );
}

function isV28BlockScope(value: unknown): value is V28BlockMeta['scope'] {
  return value === 'system' || value === 'user' || value === 'shared';
}

/**
 * Git-backed block store.
 *
 * Moi block la 1 file Markdown trong repo git rieng. Moi lan ghi la
 * 1 commit. Khi git khong co san (`gitAvailable === false`), moi
 * thao tac file van chay binh thuong va lich su du phong ghi vao
 * `history.jsonl` (snapshot day du noi dung tung version).
 */
export class V28GitBlockStore {
  readonly repoDir: string;
  readonly blocksDir: string;
  readonly historyPath: string;
  readonly archivedDir: string;
  readonly gitAuthorName: string;
  readonly gitAuthorEmail: string;
  readonly gitPath: string;
  private gitAvailableCache: boolean | null = null;
  private initialized = false;

  constructor(opts: V28GitStoreOptions) {
    this.repoDir = join(opts.rootDir, V28_ROOT_DIR_NAME);
    this.blocksDir = join(this.repoDir, V28_BLOCKS_DIR_NAME);
    this.historyPath = join(this.repoDir, V28_HISTORY_FILENAME);
    this.archivedDir = join(this.repoDir, V28_ARCHIVED_DIR_NAME);
    this.gitAuthorName = opts.gitAuthorName ?? 'open-bot';
    this.gitAuthorEmail = opts.gitAuthorEmail ?? 'open-bot@local';
    this.gitPath = opts.gitPath ?? 'git';
  }

  /** Kiem tra binary git co san khong (cache ket qua). */
  gitAvailable(): boolean {
    if (this.gitAvailableCache !== null) return this.gitAvailableCache;
    try {
      execFileSync(this.gitPath, ['--version'], { timeout: GIT_TIMEOUT_MS, stdio: 'pipe' });
      this.gitAvailableCache = true;
    } catch {
      this.gitAvailableCache = false;
    }
    return this.gitAvailableCache;
  }

  /** Khoi tao thu muc + repo git (neu co git). Goi truoc khi dung. */
  init(): V28Result<{ gitAvailable: boolean; repoDir: string; created: boolean }> {
    mkdirSync(this.blocksDir, { recursive: true });
    mkdirSync(this.archivedDir, { recursive: true });
    const created = !existsSync(join(this.repoDir, '.git')) && !existsSync(this.historyPath);
    const gitAvailable = this.gitAvailable();
    if (gitAvailable) {
      try {
        if (!existsSync(join(this.repoDir, '.git'))) {
          execFileSync(this.gitPath, ['init', '-q', this.repoDir], { timeout: GIT_TIMEOUT_MS, stdio: 'pipe' });
        }
        execFileSync(this.gitPath, ['-C', this.repoDir, 'config', 'user.name', this.gitAuthorName], {
          timeout: GIT_TIMEOUT_MS,
          stdio: 'pipe',
        });
        execFileSync(this.gitPath, ['-C', this.repoDir, 'config', 'user.email', this.gitAuthorEmail], {
          timeout: GIT_TIMEOUT_MS,
          stdio: 'pipe',
        });
        // Commit khoi tao neu repo dang trong (chua co commit nao).
        if (!this.hasCommits()) {
          const gitignore = join(this.repoDir, '.gitignore');
          if (!existsSync(gitignore)) writeFileSync(gitignore, 'history.jsonl\n', 'utf8');
          execFileSync(this.gitPath, ['-C', this.repoDir, 'add', '-A'], { timeout: GIT_TIMEOUT_MS, stdio: 'pipe' });
          try {
            execFileSync(
              this.gitPath,
              ['-C', this.repoDir, 'commit', '-q', '-m', '[memory-v28] init: git-backed memory blocks'],
              { timeout: GIT_TIMEOUT_MS, stdio: 'pipe' },
            );
          } catch {
            // Repo trong sau khi add (chi co .gitignore bi ignore... ) — bo qua.
          }
        }
      } catch (error) {
        this.gitAvailableCache = false;
        return okV28({ gitAvailable: false, repoDir: this.repoDir, created });
      }
    }
    this.initialized = true;
    return okV28({ gitAvailable, repoDir: this.repoDir, created });
  }

  /** Repo da co it nhat 1 commit chua. */
  hasCommits(): boolean {
    if (!this.gitAvailable()) return false;
    try {
      execFileSync(this.gitPath, ['-C', this.repoDir, 'rev-parse', '--verify', 'HEAD'], {
        timeout: GIT_TIMEOUT_MS,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Commit HEAD hien tai (rong neu chua co commit). */
  headCommit(): string {
    if (!this.gitAvailable() || !this.hasCommits()) return '';
    try {
      return execFileSync(this.gitPath, ['-C', this.repoDir, 'rev-parse', 'HEAD'], {
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  }

  /** Tong so commit trong repo (0 khi khong co git). */
  commitCount(): number {
    if (!this.gitAvailable() || !this.hasCommits()) return 0;
    try {
      const out = execFileSync(this.gitPath, ['-C', this.repoDir, 'rev-list', '--count', 'HEAD'], {
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf8',
      }).trim();
      return Number(out) || 0;
    } catch {
      return 0;
    }
  }

  private blockPath(label: string): string {
    return join(this.blocksDir, `${label}.md`);
  }

  private archivedPath(label: string): string {
    return join(this.archivedDir, `${label}.md`);
  }

  private ensureInit(): void {
    if (!this.initialized) this.init();
  }

  /**
   * Guardrail scope system: block `human`/`persona` chi user hoac
   * he thong sua; actor `agent:*` bi chan ngay tai day.
   */
  static isSystemBlockWriteBlocked(label: string, actor: string | undefined): boolean {
    if (!(V28_SYSTEM_BLOCK_LABELS as readonly string[]).includes(label)) return false;
    if (!actor) return false;
    return actor.startsWith('agent:');
  }

  /** Doc block theo label; tra null khi khong co. */
  readBlock(label: string): V28Block | null {
    const normalized = normalizeBlockLabelV28(label);
    if (!isValidBlockLabelV28(normalized)) return null;
    const file = this.blockPath(normalized);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    const meta = parseV28BlockMeta(text, normalized);
    if (!meta) return null;
    const { body } = parseV28Frontmatter(text);
    return { meta, content: body.replace(/\n$/, '') };
  }

  /** Liet ke meta cua tat ca block (chua archive). */
  listBlocks(): V28BlockMeta[] {
    this.ensureInit();
    if (!existsSync(this.blocksDir)) return [];
    const out: V28BlockMeta[] = [];
    for (const file of readdirSync(this.blocksDir)) {
      if (!file.endsWith('.md')) continue;
      const label = basename(file, '.md');
      const block = this.readBlock(label);
      if (block) out.push(block.meta);
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  /** Liet ke label cac block da archive. */
  listArchived(): string[] {
    this.ensureInit();
    if (!existsSync(this.archivedDir)) return [];
    return readdirSync(this.archivedDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => basename(f, '.md'))
      .sort();
  }

  /**
   * Ghi (tao moi hoac cap nhat) mot block. Moi lan ghi la 1 commit
   * git (hoac 1 muc history.jsonl khi khong co git). Noi dung
   * khong doi va khong `force` thi bo qua, tra ve version hien tai.
   */
  writeBlock(label: string, content: string, opts: V28WriteBlockOptions = {}): V28Result<V28BlockVersion> {
    this.ensureInit();
    const normalized = normalizeBlockLabelV28(label);
    if (!isValidBlockLabelV28(normalized)) {
      return errV28(`Label block khong hop le: "${label}" (chi chu cai/so/-/_ , bat dau bang chu cai)`);
    }
    if (content.length > V28_LIMITS.maxBlockChars) {
      return errV28(`Noi dung block vuot gioi han ${V28_LIMITS.maxBlockChars} ky tu`);
    }
    const actor = opts.actor ?? 'user';
    if (V28GitBlockStore.isSystemBlockWriteBlocked(normalized, actor)) {
      return errV28(
        `Block he thong "${normalized}" chi user/he thong moi sua duoc; actor "${actor}" bi chan`,
      );
    }
    const now = new Date().toISOString();
    const existing = this.readBlock(normalized);
    // Chuan hoa: bo newline o cuoi — file luon ghi body + 1 newline,
    // readBlock luon boc 1 newline o cuoi, nen hash chi khop khi
    // content goc khong ket thuc bang newline. (Trailing newline
    // la trinh bay, khong phai noi dung.)
    const normalizedContent = content.replace(/\n+$/, '');
    const hash = hashContentV28(normalizedContent);
    if (existing && existing.meta.hash === hash && !opts.force) {
      return okV28({
        label: normalized,
        version: existing.meta.version,
        hash,
        commit: existing.meta.commit,
        parentCommit: '',
        author: actor,
        message: 'unchanged',
        createdAt: existing.meta.updatedAt,
        contentLength: normalizedContent.length,
      });
    }
    const version = (existing?.meta.version ?? 0) + 1;
    const meta: V28BlockMeta = {
      label: normalized,
      kind: opts.kind ?? existing?.meta.kind ?? 'custom',
      description: opts.description ?? existing?.meta.description ?? '',
      scope: opts.scope ?? existing?.meta.scope ?? 'user',
      readOnly: opts.readOnly ?? existing?.meta.readOnly ?? false,
      ownerBotId: opts.ownerBotId ?? existing?.meta.ownerBotId ?? '',
      version,
      hash,
      commit: '',
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
    };
    if (meta.readOnly && existing) {
      return errV28(`Block "${normalized}" dang read-only, khong ghi duoc`);
    }
    const fileText = renderV28BlockFile(meta, normalizedContent);
    const tmpPath = `${this.blockPath(normalized)}.tmp-${makeV28Id('w')}`;
    writeFileSync(tmpPath, fileText, 'utf8');
    renameSync(tmpPath, this.blockPath(normalized));
    const message = opts.message ?? `update ${normalized}`;
    const commitMessage = `[memory-v28] ${normalized} v${version}: ${message}`;
    let commit = '';
    if (this.gitAvailable()) {
      try {
        execFileSync(this.gitPath, ['-C', this.repoDir, 'add', this.blockPath(normalized)], {
          timeout: GIT_TIMEOUT_MS,
          stdio: 'pipe',
        });
        execFileSync(
          this.gitPath,
          ['-C', this.repoDir, 'commit', '-q', '-m', commitMessage, '--author', `${actor} <${actor}@local>`],
          { timeout: GIT_TIMEOUT_MS, stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_NAME: this.gitAuthorName, GIT_COMMITTER_EMAIL: this.gitAuthorEmail } },
        );
        commit = this.headCommit();
      } catch {
        // Commit that bai (vd khong co thay doi that) — roi ve fallback log.
        this.gitAvailableCache = false;
        commit = '';
      }
    }
    if (commit) {
      // Ghi lai commit vao frontmatter roi amend nhe? Khong — tranh
      // rewrite history: commit ghi trong file se cap nhat o lan ghi sau.
      meta.commit = commit;
    }
    const entry: V28HistoryEntry = {
      label: normalized,
      version,
      hash,
      commit,
      author: actor,
      message: commitMessage,
      createdAt: now,
      content: normalizedContent,
    };
    appendFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return okV28({
      label: normalized,
      version,
      hash,
      commit,
      parentCommit: existing?.meta.commit ?? '',
      author: actor,
      message: commitMessage,
      createdAt: now,
      contentLength: normalizedContent.length,
    });
  }

  /** Doc lich su fallback (history.jsonl) theo label. */
  readFallbackHistory(label: string): V28HistoryEntry[] {
    if (!existsSync(this.historyPath)) return [];
    const out: V28HistoryEntry[] = [];
    for (const line of readFileSync(this.historyPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as V28HistoryEntry;
        if (entry.label === label) out.push(entry);
      } catch {
        // Dong loi thi bo qua, khong lam hong toan bo lich su.
      }
    }
    return out;
  }

  /**
   * Lich su cua block: dung `git log` khi co git, fallback ve
   * history.jsonl khi khong co. Moi nhat truoc.
   */
  history(label: string, limit: number = V28_LIMITS.defaultHistoryLimit): V28BlockVersion[] {
    const normalized = normalizeBlockLabelV28(label);
    if (!isValidBlockLabelV28(normalized)) return [];
    const capped = Math.max(1, Math.min(limit, V28_LIMITS.maxHistoryLimit));
    if (this.gitAvailable() && this.hasCommits()) {
      try {
        const format = '%H%x1f%P%x1f%an%x1f%ad%x1f%s%x1e';
        const out = execFileSync(
          this.gitPath,
          [
            '-C', this.repoDir, 'log',
            `--max-count=${capped}`,
            `--format=${format}`,
            '--date=iso-strict',
            '--',
            this.blockPath(normalized),
          ],
          { timeout: GIT_TIMEOUT_MS, encoding: 'utf8' },
        );
        const versions: V28BlockVersion[] = [];
        for (const record of out.split('\x1e')) {
          const trimmed = record.trim();
          if (!trimmed) continue;
          const [commit, parent, author, date, message] = trimmed.split('\x1f');
          if (!commit) continue;
          const content = this.readContentAtCommit(normalized, commit);
          const hash = content === null ? '' : hashContentV28(content);
          versions.push({
            label: normalized,
            version: 0, // Dien so version o duoi (dem nguoc tu hien tai).
            hash,
            commit,
            parentCommit: (parent ?? '').split(' ')[0] ?? '',
            author: author ?? '',
            message: (message ?? '').trim(),
            createdAt: date ?? '',
            contentLength: content?.length ?? 0,
          });
        }
        // So version: version hien tai tru di vi tri trong log.
        const current = this.readBlock(normalized);
        const currentVersion = current?.meta.version ?? versions.length;
        versions.forEach((v, i) => {
          v.version = Math.max(1, currentVersion - i);
        });
        return versions;
      } catch {
        // Roi xuong fallback.
      }
    }
    return this.readFallbackHistory(normalized)
      .slice(-capped)
      .reverse()
      .map((e) => ({
        label: e.label,
        version: e.version,
        hash: e.hash,
        commit: e.commit,
        parentCommit: '',
        author: e.author,
        message: e.message,
        createdAt: e.createdAt,
        contentLength: e.content.length,
      }));
  }

  /** Doc noi dung file block tai 1 commit (null khi khong co). */
  readContentAtCommit(label: string, commit: string): string | null {
    try {
      const out = execFileSync(
        this.gitPath,
        ['-C', this.repoDir, 'show', `${commit}:${this.relativeBlockPath(label)}`],
        { timeout: GIT_TIMEOUT_MS, encoding: 'utf8' },
      );
      const { body } = parseV28Frontmatter(out);
      return body.replace(/\n$/, '');
    } catch {
      return null;
    }
  }

  private relativeBlockPath(label: string): string {
    return `${V28_BLOCKS_DIR_NAME}/${label}.md`;
  }

  /**
   * Noi dung block tai mot thoi diem: tim commit moi nhat co thay
   * doi block truoc `at`, roi doc file tai commit do. Fallback:
   * quet history.jsonl theo createdAt.
   */
  getAt(label: string, at: string | Date | number): V28Result<{ content: string; version: number; commit: string; at: string }> {
    const normalized = normalizeBlockLabelV28(label);
    const atMs = parseIsoV28(at);
    if (atMs === null) return errV28(`Thoi diem khong hop le: "${String(at)}"`);
    const atIso = isoAtV28(atMs) as string;
    if (this.gitAvailable() && this.hasCommits()) {
      try {
        // Commit HEAD tai thoi diem `at` (rev-list --before): file
        // block phai ton tai trong tree tai commit nay thi block
        // moi tinh la ton tai tai `at` — neu khong (vd block da
        // archive/chuyen cho truoc `at`) thi bao khong ton tai,
        // chu khong tra noi dung cua commit cu cham vao file.
        const headAt = execFileSync(
          this.gitPath,
          ['-C', this.repoDir, 'rev-list', '-n', '1', `--before=${atIso}`, 'HEAD'],
          { timeout: GIT_TIMEOUT_MS, encoding: 'utf8' },
        ).trim();
        if (!headAt) return errV28(`Block "${normalized}" chua ton tai tai ${atIso}`);
        const contentAtHead = this.readContentAtCommit(normalized, headAt);
        if (contentAtHead === null) {
          return errV28(`Block "${normalized}" chua ton tai tai ${atIso}`);
        }
        const out = execFileSync(
          this.gitPath,
          [
            '-C', this.repoDir, 'log',
            '--format=%H%x1f%ad',
            '--date=iso-strict',
            `--before=${atIso}`,
            '--max-count=1',
            '--',
            this.blockPath(normalized),
          ],
          { timeout: GIT_TIMEOUT_MS, encoding: 'utf8' },
        ).trim();
        if (out) {
          const [commit] = out.split('\x1f');
          if (commit) {
            const content = this.readContentAtCommit(normalized, commit);
            if (content !== null) {
              const versions = this.history(normalized, V28_LIMITS.maxHistoryLimit);
              const found = versions.find((v) => v.commit === commit);
              return okV28({ content, version: found?.version ?? 0, commit, at: atIso });
            }
          }
        }
        // Khong co commit nao cham vao file truoc `at` nhung file
        // ton tai trong tree tai `at` (khong the — chi phong thu):
        // tra noi dung tai headAt.
        return okV28({ content: contentAtHead, version: 0, commit: headAt, at: atIso });
      } catch {
        // Roi xuong fallback.
      }
    }
    const entries = this.readFallbackHistory(normalized).filter((e) => {
      const ms = parseIsoV28(e.createdAt);
      return ms !== null && ms <= atMs;
    });
    const last = entries[entries.length - 1];
    if (!last) return errV28(`Block "${normalized}" chua ton tai tai ${atIso}`);
    return okV28({ content: last.content, version: last.version, commit: last.commit, at: atIso });
  }

  /**
   * Diff 2 version cua block (theo commit hoac so version).
   * Tra ve diff dang unified khi co git; fallback la diff dong
   * don gian (dong `-`/`+`) khi khong co git.
   */
  diff(label: string, fromRef: string | number, toRef: string | number): V28Result<string> {
    const normalized = normalizeBlockLabelV28(label);
    if (!isValidBlockLabelV28(normalized)) return errV28(`Label block khong hop le: "${label}"`);
    const fromCommit = this.resolveRef(normalized, fromRef);
    const toCommit = this.resolveRef(normalized, toRef);
    if (this.gitAvailable() && fromCommit && toCommit) {
      try {
        const out = execFileSync(
          this.gitPath,
          ['-C', this.repoDir, 'diff', `${fromCommit}`, `${toCommit}`, '--', this.blockPath(normalized)],
          { timeout: GIT_TIMEOUT_MS, encoding: 'utf8' },
        );
        return okV28(out || '(khong co thay doi)\n');
      } catch {
        // Roi xuong diff dong.
      }
    }
    const fromContent = this.resolveContent(normalized, fromRef);
    const toContent = this.resolveContent(normalized, toRef);
    if (fromContent === null || toContent === null) {
      return errV28(`Khong giai quyet duoc ref "${String(fromRef)}" hoac "${String(toRef)}" cho block "${normalized}"`);
    }
    return okV28(simpleLineDiffV28(fromContent, toContent));
  }

  /** Giai quyet ref (commit SHA hoac so version) ve commit SHA. */
  resolveRef(label: string, ref: string | number): string {
    if (typeof ref === 'string' && /^[0-9a-f]{7,40}$/i.test(ref)) return ref;
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const version = Number(ref);
      const versions = this.history(label, V28_LIMITS.maxHistoryLimit);
      return versions.find((v) => v.version === version)?.commit ?? '';
    }
    return '';
  }

  /** Giai quyet ref ve noi dung (dung git hoac fallback history). */
  resolveContent(label: string, ref: string | number): string | null {
    const normalized = normalizeBlockLabelV28(label);
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const entries = this.readFallbackHistory(normalized);
      const found = entries.find((e) => e.version === Number(ref));
      if (found) return found.content;
      const commit = this.resolveRef(normalized, ref);
      if (commit) return this.readContentAtCommit(normalized, commit);
      return null;
    }
    if (typeof ref === 'string') {
      if (ref === 'HEAD' || ref === 'current') {
        const block = this.readBlock(normalized);
        return block ? block.content : null;
      }
      return this.readContentAtCommit(normalized, ref);
    }
    return null;
  }

  /**
   * Rollback block ve 1 version cu: noi dung cu duoc commit thanh
   * version MOI (khong rewrite history). Tra ve version moi.
   */
  rollback(label: string, target: string | number, opts: { actor?: string; message?: string } = {}): V28Result<V28BlockVersion> {
    const normalized = normalizeBlockLabelV28(label);
    const content = this.resolveContent(normalized, target);
    if (content === null) {
      return errV28(`Khong tim thay version "${String(target)}" cua block "${normalized}" de rollback`);
    }
    const current = this.readBlock(normalized);
    if (current && normalizeTextV28(current.content) === normalizeTextV28(content)) {
      return errV28(`Block "${normalized}" da o dung noi dung version "${String(target)}"`);
    }
    return this.writeBlock(normalized, content, {
      actor: opts.actor ?? 'user',
      message: opts.message ?? `rollback to ${String(target)}`,
      force: true,
      kind: current?.meta.kind,
      description: current?.meta.description,
      scope: current?.meta.scope,
      ownerBotId: current?.meta.ownerBotId,
    });
  }

  /**
   * Archive block: chuyen file sang `archived/` + commit. Block
   * khong con nam trong listBlocks nhung lich su git van giu.
   */
  archiveBlock(label: string, opts: { actor?: string; message?: string } = {}): V28Result<string> {
    this.ensureInit();
    const normalized = normalizeBlockLabelV28(label);
    const block = this.readBlock(normalized);
    if (!block) return errV28(`Khong co block "${normalized}" de archive`);
    const actor = opts.actor ?? 'user';
    if (V28GitBlockStore.isSystemBlockWriteBlocked(normalized, actor)) {
      return errV28(`Block he thong "${normalized}" chi user/he thong moi archive duoc`);
    }
    const target = this.archivedPath(normalized);
    renameSync(this.blockPath(normalized), target);
    if (this.gitAvailable()) {
      try {
        execFileSync(this.gitPath, ['-C', this.repoDir, 'add', '-A'], { timeout: GIT_TIMEOUT_MS, stdio: 'pipe' });
        execFileSync(
          this.gitPath,
          ['-C', this.repoDir, 'commit', '-q', '-m', `[memory-v28] ${normalized}: archive (${opts.message ?? 'archived'})`],
          { timeout: GIT_TIMEOUT_MS, stdio: 'pipe' },
        );
      } catch {
        // Commit that bai thi file da chuyen — van tra ok (du lieu khong mat).
      }
    }
    const entry: V28HistoryEntry = {
      label: normalized,
      version: block.meta.version,
      hash: block.meta.hash,
      commit: this.headCommit(),
      author: actor,
      message: `[memory-v28] ${normalized}: archive`,
      createdAt: new Date().toISOString(),
      content: block.content,
    };
    appendFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return okV28(`Da archive block "${normalized}" (lich su git van giu)`);
  }

  /** Trang thai tong quan cua store (dung cho panel/stats). */
  status(): { gitAvailable: boolean; repoDir: string; blocks: number; commits: number; head: string } {
    return {
      gitAvailable: this.gitAvailable(),
      repoDir: this.repoDir,
      blocks: this.listBlocks().length,
      commits: this.commitCount(),
      head: this.headCommit(),
    };
  }
}

/** Diff dong don gian: dong chi co o ban cu -> `-`, chi co o ban moi -> `+`. */
export function simpleLineDiffV28(fromContent: string, toContent: string): string {
  const fromLines = fromContent.split('\n');
  const toLines = toContent.split('\n');
  const fromSet = new Set(fromLines);
  const toSet = new Set(toLines);
  const out: string[] = ['--- from', '+++ to'];
  for (const line of fromLines) {
    if (!toSet.has(line)) out.push(`- ${line}`);
  }
  for (const line of toLines) {
    if (!fromSet.has(line)) out.push(`+ ${line}`);
  }
  if (out.length === 2) out.push('(khong co thay doi)');
  return `${out.join('\n')}\n`;
}

/** Kiem tra mot chuoi co phai SHA git hop le khong. */
export function isGitShaV28(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}
