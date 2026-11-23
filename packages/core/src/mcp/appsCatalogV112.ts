/**
 * MCP Apps catalogue v2 (v1.12, Doi T6).
 *
 * Tang tren `mcp/apps.ts` (host-side validation + iframe sandbox) va
 * `mcp/appsV2.ts` (template): v0.97/v0.98 tra loi "HTML cua app co an
 * toan de render khong". Module nay tra loi cau hoi truoc do, o tang
 * catalogue: "app nay la gi, co cai duoc tren may nay khong, va no
 * dang o trang thai nao".
 *
 * - Catalogue co dinh 12 app (khong tai tu mang — danh sach nam trong
 *   code, giong cach COMPOSIO_TOOLKITS liet ke toolkit): moi app co
 *   manifest day du (id, version semver, server cung cap, category,
 *   quyen can, host version toi thieu, co can mang khong).
 * - Kiem tra tuong thich (`checkMcpAppV112Compatibility`): so version
 *   host (semver), quyen app xin vs quyen host cho phep, app can mang
 *   trong khi host cam mang, sandbox yeu cau. Tra ly do cu the khi
 *   khong tuong thich — khong bao gio cai len roi moi bao loi.
 * - Cai/go (`install`/`uninstall`/`enable`/`disable`): trang thai
 *   luu vao `<userData>/mcp-apps-v112.json` (atomic tmp + rename,
 *   mode 0600). Cai mot app khong tuong thich thi throw — fail-closed.
 *   Go mot app thi xoa trang thai cua no; app dang mo (open) thi
 *   host phai dong truoc (caller tu chiu trach nhiem — ham nay chi
 *   ghi so, khong dong iframe).
 * - Tim kiem/loc: theo ten/mo ta/tag/category; chi hien app tuong
 *   thich neu caller yeu cau.
 *
 * Khong goi mang, khong tai code: catalogue la metadata tinh; code
 * HTML that cua app van do MCP server tra ve luc chay va van phai qua
 * `validateAppHtml` cua apps.ts truoc khi render.
 */

import { APP_VERSION } from '../appVersion';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File luu trang thai cai dat app v112 trong userData dir. */
export const MCP_APPS_V112_FILE = 'mcp-apps-v112.json';
/** So app toi da trong catalogue (chan catalogue phong vo han). */
export const MCP_APPS_V112_MAX_CATALOGUE = 64;
/** Version host hien tai cua open-bot (dung de kiem tra tuong thich). */
export const MCP_APPS_V112_HOST_VERSION = APP_VERSION;

/** Quyen mot MCP app co the xin. */
export type McpAppV112Permission =
  | 'read-files'
  | 'write-files'
  | 'network'
  | 'clipboard'
  | 'notifications';

export const MCP_APP_V112_PERMISSIONS: readonly McpAppV112Permission[] = [
  'read-files',
  'write-files',
  'network',
  'clipboard',
  'notifications',
];

/** Nhom app trong catalogue. */
export type McpAppV112Category =
  | 'productivity'
  | 'data'
  | 'developer'
  | 'communication'
  | 'utility';

export const MCP_APP_V112_CATEGORIES: readonly McpAppV112Category[] = [
  'productivity',
  'data',
  'developer',
  'communication',
  'utility',
];

/** Manifest cua mot app trong catalogue. */
export interface McpAppV112Entry {
  /** Id on dinh, vd 'kanban-board'. */
  id: string;
  name: string;
  /** Version semver `MAJOR.MINOR.PATCH`. */
  version: string;
  description: string;
  /** MCP server cung cap app nay (vd 'open-bot-apps'). */
  serverId: string;
  category: McpAppV112Category;
  /** Quyen app xin khi chay. */
  permissions: McpAppV112Permission[];
  /** Host version toi thieu (semver). */
  minHostVersion: string;
  /** Host version toi da ho tro (null = khong gioi han). */
  maxHostVersion: string | null;
  /** App co can mang khong (neu co, host phai cho phep network). */
  needsNetwork: boolean;
  /** App co can chay script trong iframe khong (luon true voi MCP Apps). */
  needsScripts: boolean;
  tags: string[];
  /** Kich thuoc uoc tinh (KB) — de UI hien, khong phai so do that. */
  installSizeKb: number;
}

/** Kha nang cua host dung de kiem tra tuong thich. */
export interface McpAppV112HostCaps {
  /** Version host (semver). */
  hostVersion: string;
  /** Quyen host san sang cap cho app. */
  grantedPermissions: McpAppV112Permission[];
  /** Host co cho phep app goi mang khong. */
  allowNetwork: boolean;
  /** Host co bat sandbox chat (`allow-scripts` only) khong. */
  sandboxStrict: boolean;
}

export interface McpAppV112Compatibility {
  compatible: boolean;
  reasons: string[];
}

/** Trang thai cai dat cua mot app. */
export interface McpAppV112Install {
  appId: string;
  version: string;
  serverId: string;
  installedAtMs: number;
  enabled: boolean;
}

export const DEFAULT_MCP_APP_V112_HOST_CAPS: McpAppV112HostCaps = {
  hostVersion: MCP_APPS_V112_HOST_VERSION,
  grantedPermissions: ['read-files', 'clipboard', 'notifications'],
  allowNetwork: false,
  sandboxStrict: true,
};

// ---------------------------------------------------------------------------
// Catalogue (12 app co dinh)
// ---------------------------------------------------------------------------

export const MCP_APPS_V112_CATALOGUE: readonly McpAppV112Entry[] = [
  {
    id: 'kanban-board',
    name: 'Kanban Board',
    version: '1.2.0',
    description: 'Bang kanban keo-tha theo doi cong viec theo cot (todo/doing/done), luu trang thai local.',
    serverId: 'open-bot-apps',
    category: 'productivity',
    permissions: ['read-files', 'write-files'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['board', 'tasks', 'planning'],
    installSizeKb: 180,
  },
  {
    id: 'markdown-preview',
    name: 'Markdown Preview',
    version: '1.0.3',
    description: 'Xem truoc markdown voi muc luc va highlight code, chi doc file local.',
    serverId: 'open-bot-apps',
    category: 'developer',
    permissions: ['read-files'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['markdown', 'docs', 'preview'],
    installSizeKb: 95,
  },
  {
    id: 'chart-dashboard',
    name: 'Chart Dashboard',
    version: '2.1.0',
    description: 'Ve bieu do tu du lieu bang local (CSV/JSON) — khong gui du lieu ra ngoai.',
    serverId: 'open-bot-apps',
    category: 'data',
    permissions: ['read-files'],
    minHostVersion: '0.2.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['chart', 'data', 'analytics'],
    installSizeKb: 240,
  },
  {
    id: 'file-browser',
    name: 'File Browser',
    version: '1.4.1',
    description: 'Duyet cay thu muc workspace, xem/xoa file trong sandbox cua bot.',
    serverId: 'open-bot-apps',
    category: 'developer',
    permissions: ['read-files', 'write-files'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['files', 'workspace', 'browser'],
    installSizeKb: 150,
  },
  {
    id: 'calendar-view',
    name: 'Calendar View',
    version: '1.1.0',
    description: 'Lich thang/tuan hien su kien tu lich local cua bot, nhac truoc gio hen.',
    serverId: 'open-bot-apps',
    category: 'productivity',
    permissions: ['read-files', 'notifications'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['calendar', 'schedule', 'events'],
    installSizeKb: 130,
  },
  {
    id: 'poll-maker',
    name: 'Poll Maker',
    version: '1.0.0',
    description: 'Tao poll binh chon nhanh trong chat nhom, tong hop ket qua local.',
    serverId: 'open-bot-apps',
    category: 'communication',
    permissions: ['notifications'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['poll', 'vote', 'group'],
    installSizeKb: 70,
  },
  {
    id: 'code-snippets',
    name: 'Code Snippets',
    version: '1.3.2',
    description: 'Luu va tim snippet code theo ngon ngu, copy nhanh vao clipboard.',
    serverId: 'open-bot-apps',
    category: 'developer',
    permissions: ['read-files', 'write-files', 'clipboard'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['code', 'snippets', 'search'],
    installSizeKb: 110,
  },
  {
    id: 'weather-widget',
    name: 'Weather Widget',
    version: '1.0.5',
    description: 'Tien ich thoi tiet chay bang du lieu mau local (khong goi API that) — dung de demo MCP Apps.',
    serverId: 'open-bot-apps',
    category: 'utility',
    permissions: [],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['weather', 'widget', 'demo'],
    installSizeKb: 45,
  },
  {
    id: 'focus-timer',
    name: 'Focus Timer',
    version: '1.0.1',
    description: 'Dong ho Pomodoro: 25 phut tap trung / 5 phut nghi, thong bao khi het gio.',
    serverId: 'open-bot-apps',
    category: 'productivity',
    permissions: ['notifications'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['timer', 'pomodoro', 'focus'],
    installSizeKb: 60,
  },
  {
    id: 'quick-notes',
    name: 'Quick Notes',
    version: '1.2.4',
    description: 'Ghi chu nhanh kem tag, tim kiem tuc thi, luu local trong workspace.',
    serverId: 'open-bot-apps',
    category: 'productivity',
    permissions: ['read-files', 'write-files'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['notes', 'tags', 'search'],
    installSizeKb: 85,
  },
  {
    id: 'git-status',
    name: 'Git Status',
    version: '1.5.0',
    description: 'Xem nhanh branch, file doi va lich su commit gan nhat cua repo workspace.',
    serverId: 'open-bot-apps',
    category: 'developer',
    permissions: ['read-files'],
    minHostVersion: '0.2.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['git', 'repo', 'status'],
    installSizeKb: 120,
  },
  {
    id: 'todo-board',
    name: 'Todo Board',
    version: '1.0.2',
    description: 'Danh sach viec can lam don gian co han chot va nhac nho, dong bo voi automation v2.',
    serverId: 'open-bot-apps',
    category: 'productivity',
    permissions: ['read-files', 'write-files', 'notifications'],
    minHostVersion: '0.1.0',
    maxHostVersion: null,
    needsNetwork: false,
    needsScripts: true,
    tags: ['todo', 'tasks', 'reminders'],
    installSizeKb: 90,
  },
];

// ---------------------------------------------------------------------------
// Semver (don gian, chi MAJOR.MINOR.PATCH)
// ---------------------------------------------------------------------------

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseMcpAppV112Semver(version: string): [number, number, number] {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) throw new Error(`invalid semver: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1 = a < b, 0 = bang, 1 = a > b. */
export function compareMcpAppV112Semver(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = parseMcpAppV112Semver(a);
  const [bMaj, bMin, bPatch] = parseMcpAppV112Semver(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Validation + lookup + search
// ---------------------------------------------------------------------------

export function validateMcpAppV112Entry(entry: unknown): McpAppV112Entry {
  if (!entry || typeof entry !== 'object') throw new Error('app entry must be an object.');
  const e = entry as Partial<McpAppV112Entry>;
  if (typeof e.id !== 'string' || e.id.trim() === '') throw new Error('app.id must be a non-empty string.');
  if (typeof e.name !== 'string' || e.name.trim() === '') throw new Error('app.name must be a non-empty string.');
  parseMcpAppV112Semver(e.version as string);
  if (typeof e.description !== 'string' || e.description.trim() === '') {
    throw new Error('app.description must be a non-empty string.');
  }
  if (typeof e.serverId !== 'string' || e.serverId.trim() === '') {
    throw new Error('app.serverId must be a non-empty string.');
  }
  if (!MCP_APP_V112_CATEGORIES.includes(e.category as McpAppV112Category)) {
    throw new Error(`app.category must be one of: ${MCP_APP_V112_CATEGORIES.join(', ')}.`);
  }
  if (!Array.isArray(e.permissions)) throw new Error('app.permissions must be an array.');
  for (const p of e.permissions as string[]) {
    if (!MCP_APP_V112_PERMISSIONS.includes(p as McpAppV112Permission)) {
      throw new Error(`unknown permission: ${p}`);
    }
  }
  if (new Set(e.permissions).size !== e.permissions.length) {
    throw new Error('app.permissions must not contain duplicates.');
  }
  parseMcpAppV112Semver(e.minHostVersion as string);
  if (e.maxHostVersion !== null) parseMcpAppV112Semver(e.maxHostVersion as string);
  if (e.maxHostVersion !== null && compareMcpAppV112Semver(e.maxHostVersion as string, e.minHostVersion as string) < 0) {
    throw new Error('app.maxHostVersion must be >= minHostVersion.');
  }
  if (typeof e.needsNetwork !== 'boolean') throw new Error('app.needsNetwork must be a boolean.');
  if (typeof e.needsScripts !== 'boolean') throw new Error('app.needsScripts must be a boolean.');
  if (!Array.isArray(e.tags)) throw new Error('app.tags must be an array.');
  if (!Number.isInteger(e.installSizeKb) || (e.installSizeKb as number) < 0) {
    throw new Error('app.installSizeKb must be a non-negative integer.');
  }
  return e as McpAppV112Entry;
}

export function validateMcpAppV112Catalogue(
  catalogue: readonly McpAppV112Entry[],
): McpAppV112Entry[] {
  if (catalogue.length > MCP_APPS_V112_MAX_CATALOGUE) {
    throw new Error(`catalogue too large (${catalogue.length} > ${MCP_APPS_V112_MAX_CATALOGUE}).`);
  }
  const seen = new Set<string>();
  const out: McpAppV112Entry[] = [];
  for (const entry of catalogue) {
    const valid = validateMcpAppV112Entry(entry);
    if (seen.has(valid.id)) throw new Error(`duplicate app id in catalogue: ${valid.id}`);
    seen.add(valid.id);
    out.push(valid);
  }
  return out;
}

/** Tim app theo id trong catalogue (mac dinh: catalogue co dinh). */
export function findMcpAppV112(
  catalogue: readonly McpAppV112Entry[] = MCP_APPS_V112_CATALOGUE,
  id: string,
): McpAppV112Entry | undefined {
  return catalogue.find((e) => e.id === id);
}

/** Tim kiem app theo chuoi (ten/mo ta/tag), loc theo category tuy chon. */
export function searchMcpAppsV112(
  query: string,
  options: {
    catalogue?: readonly McpAppV112Entry[];
    category?: McpAppV112Category;
    onlyCompatible?: boolean;
    hostCaps?: McpAppV112HostCaps;
  } = {},
): McpAppV112Entry[] {
  const catalogue = options.catalogue ?? MCP_APPS_V112_CATALOGUE;
  const needle = query.trim().toLowerCase();
  return catalogue.filter((entry) => {
    if (options.category !== undefined && entry.category !== options.category) return false;
    if (needle.length > 0) {
      const haystack = `${entry.name} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (options.onlyCompatible === true) {
      const caps = options.hostCaps ?? DEFAULT_MCP_APP_V112_HOST_CAPS;
      if (!checkMcpAppV112Compatibility(entry, caps).compatible) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/**
 * App co chay duoc tren host nay khong. Kiem tra theo thu tu:
 * version host -> quyen -> mang -> sandbox. Tra ly do cu the cho tung
 * loi — UI hien ly do thay vi chi "khong tuong thich".
 */
export function checkMcpAppV112Compatibility(
  entry: McpAppV112Entry,
  hostCaps: McpAppV112HostCaps,
): McpAppV112Compatibility {
  validateMcpAppV112Entry(entry);
  const reasons: string[] = [];
  if (compareMcpAppV112Semver(hostCaps.hostVersion, entry.minHostVersion) < 0) {
    reasons.push(`needs host >= ${entry.minHostVersion}, have ${hostCaps.hostVersion}`);
  }
  if (entry.maxHostVersion !== null && compareMcpAppV112Semver(hostCaps.hostVersion, entry.maxHostVersion) > 0) {
    reasons.push(`needs host <= ${entry.maxHostVersion}, have ${hostCaps.hostVersion}`);
  }
  for (const permission of entry.permissions) {
    if (!hostCaps.grantedPermissions.includes(permission)) {
      reasons.push(`host does not grant permission: ${permission}`);
    }
  }
  if (entry.needsNetwork && !hostCaps.allowNetwork) {
    reasons.push('app needs network but host blocks network for apps');
  }
  if (entry.needsScripts && !hostCaps.sandboxStrict) {
    // Sandbox khong chat + app can script = host khong dam bao an toan.
    reasons.push('app needs scripts but host sandbox is not strict');
  }
  return { compatible: reasons.length === 0, reasons };
}

/** Validate host caps (de test/host tu build caps khong bi sai kieu). */
export function validateMcpAppV112HostCaps(caps: unknown): McpAppV112HostCaps {
  if (!caps || typeof caps !== 'object') throw new Error('hostCaps must be an object.');
  const c = caps as Partial<McpAppV112HostCaps>;
  parseMcpAppV112Semver(c.hostVersion as string);
  if (!Array.isArray(c.grantedPermissions)) throw new Error('grantedPermissions must be an array.');
  for (const p of c.grantedPermissions as string[]) {
    if (!MCP_APP_V112_PERMISSIONS.includes(p as McpAppV112Permission)) {
      throw new Error(`unknown granted permission: ${p}`);
    }
  }
  if (typeof c.allowNetwork !== 'boolean') throw new Error('allowNetwork must be a boolean.');
  if (typeof c.sandboxStrict !== 'boolean') throw new Error('sandboxStrict must be a boolean.');
  return c as McpAppV112HostCaps;
}

// ---------------------------------------------------------------------------
// Install state (pure transitions + file store)
// ---------------------------------------------------------------------------

export function validateMcpAppV112Install(input: unknown): McpAppV112Install {
  if (!input || typeof input !== 'object') throw new Error('install must be an object.');
  const inst = input as Partial<McpAppV112Install>;
  if (typeof inst.appId !== 'string' || inst.appId.trim() === '') {
    throw new Error('install.appId must be a non-empty string.');
  }
  parseMcpAppV112Semver(inst.version as string);
  if (typeof inst.serverId !== 'string' || inst.serverId.trim() === '') {
    throw new Error('install.serverId must be a non-empty string.');
  }
  if (!Number.isFinite(inst.installedAtMs)) throw new Error('install.installedAtMs must be finite.');
  if (typeof inst.enabled !== 'boolean') throw new Error('install.enabled must be a boolean.');
  return inst as McpAppV112Install;
}

/**
 * Cai app: fail-closed khi app khong co trong catalogue, khong tuong
 * thich, hoac da cai roi. Cai lai cung version thi throw (dung
 * `upgrade` neu muon doi version — v112 chua ho tro upgrade, de tranh
 * ghi de trang thai am tham).
 */
export function installMcpAppV112(
  installs: readonly McpAppV112Install[],
  catalogue: readonly McpAppV112Entry[] = MCP_APPS_V112_CATALOGUE,
  appId: string,
  hostCaps: McpAppV112HostCaps = DEFAULT_MCP_APP_V112_HOST_CAPS,
  nowMs: number = Date.now(),
): { installs: McpAppV112Install[]; install: McpAppV112Install } {
  const entry = findMcpAppV112(catalogue, appId);
  if (!entry) throw new Error(`app not in catalogue: ${appId}`);
  const compat = checkMcpAppV112Compatibility(entry, validateMcpAppV112HostCaps(hostCaps));
  if (!compat.compatible) {
    throw new Error(`app ${appId} is not compatible with this host: ${compat.reasons.join('; ')}`);
  }
  if (installs.some((i) => i.appId === appId)) {
    throw new Error(`app already installed: ${appId}`);
  }
  const install: McpAppV112Install = {
    appId: entry.id,
    version: entry.version,
    serverId: entry.serverId,
    installedAtMs: nowMs,
    enabled: true,
  };
  validateMcpAppV112Install(install);
  return { installs: [...installs, install], install };
}

/** Go app (xoa trang thai cai dat). */
export function uninstallMcpAppV112(
  installs: readonly McpAppV112Install[],
  appId: string,
): McpAppV112Install[] {
  if (!installs.some((i) => i.appId === appId)) throw new Error(`app not installed: ${appId}`);
  return installs.filter((i) => i.appId !== appId);
}

/** Bat/tat mot app da cai (tat khong go — giu trang thai de bat lai). */
export function setMcpAppV112Enabled(
  installs: readonly McpAppV112Install[],
  appId: string,
  enabled: boolean,
): McpAppV112Install[] {
  const idx = installs.findIndex((i) => i.appId === appId);
  if (idx === -1) throw new Error(`app not installed: ${appId}`);
  return installs.map((i, n) => (n === idx ? { ...i, enabled } : i));
}

export function findMcpAppV112Install(
  installs: readonly McpAppV112Install[],
  appId: string,
): McpAppV112Install | undefined {
  return installs.find((i) => i.appId === appId);
}

/** App co dang cai + bat khong. */
export function isMcpAppV112Active(
  installs: readonly McpAppV112Install[],
  appId: string,
): boolean {
  const install = findMcpAppV112Install(installs, appId);
  return install !== undefined && install.enabled;
}

/**
 * Tom tat trang thai catalogue cho UI: moi app kem trang thai cai dat
 * + tuong thich tren host hien tai.
 */
export function summarizeMcpAppsV112(
  catalogue: readonly McpAppV112Entry[] = MCP_APPS_V112_CATALOGUE,
  installs: readonly McpAppV112Install[] = [],
  hostCaps: McpAppV112HostCaps = DEFAULT_MCP_APP_V112_HOST_CAPS,
): {
  app: McpAppV112Entry;
  installed: boolean;
  enabled: boolean;
  compatible: boolean;
  incompatibilityReasons: string[];
}[] {
  return catalogue.map((entry) => {
    const install = findMcpAppV112Install(installs, entry.id);
    const compat = checkMcpAppV112Compatibility(entry, hostCaps);
    return {
      app: entry,
      installed: install !== undefined,
      enabled: install?.enabled ?? false,
      compatible: compat.compatible,
      incompatibilityReasons: compat.reasons,
    };
  });
}

// ---------------------------------------------------------------------------
// File store
// ---------------------------------------------------------------------------

export function getMcpAppsV112Path(userDataDir: string): string {
  return path.join(userDataDir, MCP_APPS_V112_FILE);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

export function loadMcpAppV112Installs(userDataDir: string): McpAppV112Install[] {
  const file = getMcpAppsV112Path(userDataDir);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: McpAppV112Install[] = [];
  for (const item of parsed) {
    try {
      out.push(validateMcpAppV112Install(item));
    } catch {
      // Bo muc hong, giu muc tot.
    }
  }
  return out;
}

export function saveMcpAppV112Installs(
  userDataDir: string,
  installs: readonly McpAppV112Install[],
): void {
  atomicWriteJson(getMcpAppsV112Path(userDataDir), installs.map((i) => validateMcpAppV112Install(i)));
}
