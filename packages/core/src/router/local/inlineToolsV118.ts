/**
 * Inline tools — doi tool giua hoi thoai khong pha prompt cache
 * (v1.41, Doi T3).
 *
 * Y tuong tu survey docs/repo-survey-v141.md §1 (beta
 * `inline-tools-2026-09-15`, chi hoc y tuong, khong copy code/text/
 * tai san cua bat ky repo nao):
 * - Doi tool giua hoi thoai khong pha prompt cache: phan prefix
 *   (system prompt + lich su hoi thoai) giu nguyen cache key, chi
 *   phan tool set co key rieng. Router tach cache key thanh hai
 *   thanh phan doc lap de chung minh dieu do.
 * - Server-side threads dong bang tool list: thread nao da khoa tool
 *   list thi doi tool phai tao thread moi (hoac tra loi
 *   `thread_fingerprint_mismatch`) thay vi gui len roi nhan 400.
 *
 * Module nay thuan logic (khong goi API that): versioning tool set,
 * hash on dinh (FNV-1a + JSON canonical — khong phu thuoc thu tu key
 * cua object), tach cache key prefix/tool, kiem tra thread fingerprint.
 */

/** Mo ta toi thieu cua mot tool trong tool set (du de hash + version). */
export interface InlineToolDef {
  name: string;
  description?: string;
  /** JSON Schema dang object (da chuan hoa; undefined = khong co). */
  parameters?: Record<string, unknown>;
}

/** Mot phien ban cua tool set. */
export interface ToolSetVersion {
  /** So phien ban tang dan, bat dau tu 1. */
  version: number;
  /** Hash on dinh cua toan bo tool set (thu tu tool da sort). */
  hash: string;
  /** Ten tool da sort (de so sanh nhanh). */
  toolNames: string[];
  createdAt: number;
  /** Ly do tao phien ban nay (vd 'initial', 'add:foo', 'remove:bar'). */
  reason: string;
}

/** Trang thai day du cua tool set dang dung trong mot hoi thoai. */
export interface InlineToolSetState {
  current: ToolSetVersion;
  tools: InlineToolDef[];
  /** Lich su phien ban (moi nhat cuoi cung; gioi han 50). */
  history: ToolSetVersion[];
}

/** FNV-1a 32-bit — hash nhanh, on dinh giua cac lan chay (khong dung
 *  Math.random / Date lam hash). */
export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * JSON canonical: sort key de quy (object), giu nguyen thu tu array.
 * Cung mot gia tri logic -> cung mot chuoi -> cung mot hash, bat ke
 * thu tu key luc truyen vao.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** Hash cua mot tool (ten + mo ta + schema canonical). */
export function hashInlineTool(tool: InlineToolDef): string {
  return fnv1aHash(
    canonicalJson({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? {},
    }),
  );
}

/** Hash cua ca tool set (tool sort theo ten truoc khi hash). */
export function hashToolSet(tools: readonly InlineToolDef[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return fnv1aHash(sorted.map((t) => hashInlineTool(t)).join('|'));
}

function sortedToolNames(tools: readonly InlineToolDef[]): string[] {
  return [...tools].map((t) => t.name).sort();
}

/** Tao tool set ban dau (version 1). */
export function createToolSet(tools: readonly InlineToolDef[], now = Date.now()): InlineToolSetState {
  const normalized = normalizeToolList(tools);
  const version: ToolSetVersion = {
    version: 1,
    hash: hashToolSet(normalized),
    toolNames: sortedToolNames(normalized),
    createdAt: now,
    reason: 'initial',
  };
  return { current: version, tools: normalized, history: [version] };
}

/** Kiem tra ten tool hop le + trung lap; tra danh sach da sort theo ten. */
export function normalizeToolList(tools: readonly InlineToolDef[]): InlineToolDef[] {
  const seen = new Set<string>();
  const out: InlineToolDef[] = [];
  for (const tool of tools) {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (name === '') throw new Error('Tool name khong duoc rong.');
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`Tool name "${name}" chua ky tu khong hop le (chi cho A-Z a-z 0-9 _ -).`);
    }
    if (seen.has(name)) throw new Error(`Tool name "${name}" bi trung lap.`);
    seen.add(name);
    out.push({
      name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? {},
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Thay doi muon ap dung len tool set. */
export interface ToolSetChange {
  add?: readonly InlineToolDef[];
  remove?: readonly string[];
  /** Thay the dinh nghia cua tool da co (ten phai ton tai). */
  replace?: readonly InlineToolDef[];
}

export interface ApplyToolSetChangeResult {
  state: InlineToolSetState;
  /** Co thay doi that khong (neu khong, version giu nguyen). */
  changed: boolean;
  added: string[];
  removed: string[];
  replaced: string[];
  /** Ly do ghi vao version moi ('' neu khong doi). */
  reason: string;
}

/**
 * Ap dung thay doi len tool set:
 * - Khong doi that (add tool da co y hett, remove tool khong co) ->
 *   tra lai state cu, version giu nguyen (khong pha cache vo ich).
 * - Co doi -> version + 1, hash moi, history giu toi da 50 ban.
 */
export function applyToolSetChange(
  state: InlineToolSetState,
  change: ToolSetChange,
  now = Date.now(),
): ApplyToolSetChangeResult {
  const byName = new Map(state.tools.map((t) => [t.name, t]));
  const added: string[] = [];
  const removed: string[] = [];
  const replaced: string[] = [];

  for (const tool of change.add ?? []) {
    const normalized = normalizeToolList([tool])[0] as InlineToolDef;
    if (byName.has(normalized.name)) {
      // Add tool da co voi dinh nghia y het = khong doi; dinh nghia
      // khac = replace ngam dinh.
      const existing = byName.get(normalized.name) as InlineToolDef;
      if (hashInlineTool(existing) !== hashInlineTool(normalized)) {
        byName.set(normalized.name, normalized);
        replaced.push(normalized.name);
      }
    } else {
      byName.set(normalized.name, normalized);
      added.push(normalized.name);
    }
  }
  for (const name of change.remove ?? []) {
    if (byName.delete(name)) removed.push(name);
  }
  for (const tool of change.replace ?? []) {
    const normalized = normalizeToolList([tool])[0] as InlineToolDef;
    if (!byName.has(normalized.name)) {
      throw new Error(`Khong the replace tool "${normalized.name}" chua ton tai — dung add.`);
    }
    const existing = byName.get(normalized.name) as InlineToolDef;
    if (hashInlineTool(existing) !== hashInlineTool(normalized)) {
      byName.set(normalized.name, normalized);
      replaced.push(normalized.name);
    }
  }

  if (added.length === 0 && removed.length === 0 && replaced.length === 0) {
    return { state, changed: false, added, removed, replaced, reason: '' };
  }
  const tools = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const reasonParts: string[] = [];
  if (added.length > 0) reasonParts.push(`add:${added.sort().join(',')}`);
  if (removed.length > 0) reasonParts.push(`remove:${removed.sort().join(',')}`);
  if (replaced.length > 0) reasonParts.push(`replace:${replaced.sort().join(',')}`);
  const version: ToolSetVersion = {
    version: state.current.version + 1,
    hash: hashToolSet(tools),
    toolNames: sortedToolNames(tools),
    createdAt: now,
    reason: reasonParts.join(';'),
  };
  const history = [...state.history, version].slice(-50);
  return {
    state: { current: version, tools, history },
    changed: true,
    added,
    removed,
    replaced,
    reason: version.reason,
  };
}

/** Cache key tach hai thanh phan: prefix (system + history) va tool set. */
export interface SplitCacheKey {
  /** Key cua phan prefix — KHONG doi khi chi doi tool. */
  prefixKey: string;
  /** Key cua tool set — doi theo version/hash. */
  toolKey: string;
  /** Key day du (prefix + tool) de gui kem request. */
  fullKey: string;
  toolSetVersion: number;
  toolSetHash: string;
}

/**
 * Tinh cache key tach doi cho mot turn.
 *
 * - `prefixKey` chi phu thuoc systemPrompt + messages + model + api
 *   version — doi tool khong lam doi prefixKey (chung minh inline
 *   tools khong pha prompt cache cua phan con lai).
 * - `toolKey` phu thuoc version + hash cua tool set.
 * - `fullKey` gop ca hai (de log / so sanh request).
 */
export function computeSplitCacheKey(input: {
  systemPrompt: string;
  messages: readonly { role: string; content: string }[];
  modelId: string;
  apiVersion?: string;
  toolSet: InlineToolSetState;
}): SplitCacheKey {
  const prefixPayload = canonicalJson({
    apiVersion: input.apiVersion ?? '',
    messages: input.messages.map((m) => ({ content: m.content, role: m.role })),
    modelId: input.modelId,
    systemPrompt: input.systemPrompt,
  });
  const prefixKey = fnv1aHash(prefixPayload);
  const toolKey = fnv1aHash(
    canonicalJson({
      hash: input.toolSet.current.hash,
      version: input.toolSet.current.version,
    }),
  );
  return {
    prefixKey,
    toolKey,
    fullKey: `${prefixKey}:${toolKey}`,
    toolSetVersion: input.toolSet.current.version,
    toolSetHash: input.toolSet.current.hash,
  };
}

/**
 * Chung minh doi tool khong pha cache prefix: so sanh hai split key —
 * tra ve true neu prefixKey giong nhau (chi toolKey khac).
 */
export function prefixCacheSurvivesToolChange(before: SplitCacheKey, after: SplitCacheKey): boolean {
  return before.prefixKey === after.prefixKey && before.toolKey !== after.toolKey;
}

/** Trang thai khoa tool list cua mot server-side thread. */
export interface ServerThreadToolLock {
  threadId: string;
  /** Fingerprint cua tool set luc thread bi khoa (hash tool set). */
  fingerprint: string;
  toolSetVersion: number;
  lockedAt: number;
  /** true = thread da khoa, doi tool phai tao thread moi. */
  locked: boolean;
}

/** Khoa tool list cua thread theo tool set hien tai. */
export function lockThreadToolSet(
  threadId: string,
  toolSet: InlineToolSetState,
  now = Date.now(),
): ServerThreadToolLock {
  return {
    threadId,
    fingerprint: toolSet.current.hash,
    toolSetVersion: toolSet.current.version,
    lockedAt: now,
    locked: true,
  };
}

export interface ThreadToolCheck {
  ok: boolean;
  /** true = gui request nay se nhan thread_fingerprint_mismatch. */
  wouldMismatch: boolean;
  reason: string;
}

/**
 * Kiem tra tool set hien tai co khop fingerprint cua thread da khoa
 * khong. Neu lech, caller phai tao thread moi (hoac gui kem tool set
 * cu) thay vi gui len roi nhan 400 `thread_fingerprint_mismatch`.
 */
export function checkThreadToolSet(
  lock: ServerThreadToolLock | null,
  toolSet: InlineToolSetState,
): ThreadToolCheck {
  if (lock === null || lock.locked === false) {
    return { ok: true, wouldMismatch: false, reason: 'Thread chua khoa tool list.' };
  }
  if (lock.fingerprint === toolSet.current.hash) {
    return { ok: true, wouldMismatch: false, reason: 'Tool set khop fingerprint cua thread.' };
  }
  return {
    ok: false,
    wouldMismatch: true,
    reason: `Tool set da doi (v${toolSet.current.version}, hash ${toolSet.current.hash}) so voi thread ${lock.threadId} da khoa o v${lock.toolSetVersion} — can tao thread moi.`,
  };
}

/** Loi co phai thread_fingerprint_mismatch khong. */
export function isThreadFingerprintMismatchError(status: number, message: string): boolean {
  if (status !== 400 && status !== 409) return false;
  return (message ?? '').toLowerCase().includes('thread_fingerprint_mismatch');
}

/** So sanh hai tool set: tool nao them / bot / doi dinh nghia. */
export interface ToolSetDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export function diffToolSets(
  before: readonly InlineToolDef[],
  after: readonly InlineToolDef[],
): ToolSetDiff {
  const beforeMap = new Map(before.map((t) => [t.name, t]));
  const afterMap = new Map(after.map((t) => [t.name, t]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [name, tool] of afterMap) {
    const old = beforeMap.get(name);
    if (!old) added.push(name);
    else if (hashInlineTool(old) !== hashInlineTool(tool)) changed.push(name);
    else unchanged.push(name);
  }
  for (const name of beforeMap.keys()) {
    if (!afterMap.has(name)) removed.push(name);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
  };
}
