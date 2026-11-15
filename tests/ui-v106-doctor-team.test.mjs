/**
 * UI tests for v1.06 (Team T5) — Doctor / Team / Engine picker panel.
 *
 * Part A (runtime): the pure doctor logic (doctorChecks.ts) is
 * compiled with the repo's own TypeScript into a temp dir and
 * executed — evaluateDoctor on every branch (engines none / none
 * available / partial / all, ollama on / off / unknown, memory
 * score bands, failed tasks, team missing / loaded) and
 * runDoctorChecks against a fake openBot, including probes that
 * throw (one failing probe must only degrade its own check).
 * Part B (static, repo pattern): i18n parity for the 44 doctorTeam.*
 * keys + 2 sidebar keys in all 6 locales; DoctorTeamPanel only uses
 * keys that exist (including the reused team.* / settings.engines*
 * keys); the IPC it needs is registered in main, exposed by preload
 * and mirrored in global.d.ts; the panel is wired into App (view
 * union + render branch) and Sidebar (nav entry at the end).
 *
 * Run: node --test tests/ui-v106-doctor-team.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const DOCTOR_KEYS = 44;

function readLocale(locale) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`), 'utf8'),
  );
}

function read(rel) {
  return fs.readFileSync(path.join(REPO, ...rel), 'utf8');
}

function usedKeys(source) {
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

/** Compile the pure doctor module to CJS in a temp dir and require it. */
function loadDoctorModule() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-v106-doctor-'));
  const tsc = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [
      tsc,
      '--module', 'commonjs',
      '--target', 'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
      '--outDir', tmp,
      path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'doctorChecks.ts'),
    ],
    { stdio: 'pipe' },
  );
  // tsc preserves the source tree under outDir (…/components/*.js).
  return createRequire(import.meta.url)(findCompiled(tmp, 'doctorChecks.js'));
}

/** Walk a temp dir for a compiled file by basename. */
function findCompiled(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findCompiled(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  throw new Error(`compiled ${name} not found under ${dir}`);
}

const doctor = loadDoctorModule();

function healthyInput(overrides = {}) {
  return {
    enginesTotal: 4, enginesAvailable: 4, ollamaAvailable: true, memoryScore: 90,
    tasksFailed: 0, team: { id: 't1', name: 'Team', members: [{ userId: 'u1', name: 'A', role: 'admin' }], sharedBots: [{ botId: 'b1', sharedBy: 'u1' }] },
    teamSharedBots: 1,
    ...overrides,
  };
}

function statusOf(checks, id) {
  return checks.find((c) => c.id === id).status;
}

test('doctor: all healthy -> every check passes, in fixed order', () => {
  const checks = doctor.evaluateDoctor(healthyInput());
  assert.deepEqual(checks.map((c) => c.id), ['engines', 'ollama', 'memoryHealth', 'mcpTasks', 'team']);
  assert.ok(checks.every((c) => c.status === 'pass'));
  assert.deepEqual(checks.find((c) => c.id === 'engines').vars, { available: 4, total: 4 });
  assert.deepEqual(checks.find((c) => c.id === 'team').vars, { members: 1, bots: 1 });
});

test('doctor: engines — none detected / none available fail, partial warns', () => {
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ enginesTotal: 0, enginesAvailable: 0 })), 'engines'), 'fail');
  assert.equal(doctor.evaluateDoctor(healthyInput({ enginesTotal: 0, enginesAvailable: 0 })).find((c) => c.id === 'engines').detailKey, 'doctorTeam.detail.enginesNone');
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ enginesTotal: 3, enginesAvailable: 0 })), 'engines'), 'fail');
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ enginesTotal: 3, enginesAvailable: 2 })), 'engines'), 'warn');
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ enginesTotal: 3, enginesAvailable: 3 })), 'engines'), 'pass');
});

test('doctor: ollama off/unknown warns (never fails — memory works without embeddings)', () => {
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ ollamaAvailable: false })), 'ollama'), 'warn');
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ ollamaAvailable: null })), 'ollama'), 'warn');
  assert.equal(doctor.evaluateDoctor(healthyInput({ ollamaAvailable: null })).find((c) => c.id === 'ollama').detailKey, 'doctorTeam.detail.ollamaUnknown');
});

test('doctor: memory score bands 80+ pass / 50+ warn / below fail; null fails', () => {
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ memoryScore: 80 })), 'memoryHealth'), 'pass');
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ memoryScore: 79 })), 'memoryHealth'), 'warn');
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ memoryScore: 50 })), 'memoryHealth'), 'warn');
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ memoryScore: 49 })), 'memoryHealth'), 'fail');
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ memoryScore: null })), 'memoryHealth'), 'fail');
});

test('doctor: failed tasks warn; missing team fails', () => {
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ tasksFailed: 2 })), 'mcpTasks'), 'warn');
  assert.deepEqual(doctor.evaluateDoctor(healthyInput({ tasksFailed: 2 })).find((c) => c.id === 'mcpTasks').vars, { count: 2 });
  assert.equal(statusOf(doctor.evaluateDoctor(healthyInput({ team: null, teamSharedBots: 0 })), 'team'), 'fail');
});

test('doctor: runDoctorChecks aggregates real IPC shapes; a throwing probe degrades only its check', async () => {
  const fake = {
    listEngines: async () => ({ engines: { claude: { kind: 'claude', status: 'available' }, codex: { kind: 'codex', status: 'unavailable' } }, detectedAt: '2026-11-14' }),
    getMemoryStatus: async () => { throw new Error('ollama down'); },
    getMemoryV5Health: async () => ({ health: { score: 65 }, contradictionGroups: [], recentConsolidationRuns: [] }),
    listMcpTasks: async () => [{ status: 'failed' }, { status: 'working' }],
    getTeam: async () => ({ id: 't1', name: 'Team', members: [], sharedBots: [] }),
  };
  const checks = await doctor.runDoctorChecks(fake, 'b1');
  assert.equal(checks.length, 5);
  assert.equal(statusOf(checks, 'engines'), 'warn');
  assert.equal(statusOf(checks, 'ollama'), 'warn');
  assert.equal(statusOf(checks, 'memoryHealth'), 'warn');
  assert.equal(statusOf(checks, 'mcpTasks'), 'warn');
  assert.equal(statusOf(checks, 'team'), 'pass');

  const noBot = await doctor.runDoctorChecks(fake, null);
  assert.equal(statusOf(noBot, 'ollama'), 'warn');
  assert.equal(statusOf(noBot, 'memoryHealth'), 'fail');

  const allThrowing = {
    listEngines: async () => { throw new Error('no ipc'); },
    getMemoryStatus: async () => { throw new Error('no ipc'); },
    getMemoryV5Health: async () => { throw new Error('no ipc'); },
    listMcpTasks: async () => { throw new Error('no ipc'); },
    getTeam: async () => { throw new Error('no ipc'); },
  };
  const degraded = await doctor.runDoctorChecks(allThrowing, 'b1');
  assert.equal(degraded.length, 5);
  assert.equal(statusOf(degraded, 'engines'), 'fail');
  assert.equal(statusOf(degraded, 'team'), 'fail');
});

test(`i18n parity: ${DOCTOR_KEYS} doctorTeam.* keys + 2 sidebar keys in all 6 locales`, () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const keys = Object.keys(locales.en).filter((k) => k.startsWith('doctorTeam.'));
  assert.equal(keys.length, DOCTOR_KEYS, `expected ${DOCTOR_KEYS} doctorTeam keys, got ${keys.length}`);
  for (const key of [...keys, 'sidebar.doctorTeam', 'sidebar.mcpTasksMonitor']) {
    for (const locale of LOCALES) {
      assert.ok(key in locales[locale], `${locale} thiếu key ${key}`);
      assert.equal(typeof locales[locale][key], 'string', `${locale}.${key} phải là string`);
      assert.ok(locales[locale][key].trim() !== '', `${locale}.${key} rỗng`);
    }
  }
  for (const locale of LOCALES.slice(1)) {
    const ks = Object.keys(locales[locale]).filter((k) => k.startsWith('doctorTeam.'));
    assert.deepEqual(ks.sort(), [...keys].sort(), `key set doctorTeam lệch ở ${locale}`);
  }
});

test('DoctorTeamPanel chỉ dùng key i18n đã tồn tại', () => {
  const en = readLocale('en');
  const panel = read(['apps', 'desktop', 'src', 'renderer', 'components', 'DoctorTeamPanel.tsx']);
  for (const key of usedKeys(panel)) {
    assert.ok(key in en, `DoctorTeamPanel dùng key chưa có: ${key}`);
  }
  assert.ok(panel.includes("t('doctorTeam.runDoctor')"));
  assert.ok(panel.includes("t('doctorTeam.saveEngine')"));
  assert.ok(panel.includes("t('team.exportTeam')"), 'panel phải tái dùng team.exportTeam có sẵn');
  assert.ok(panel.includes("t('team.importTeam')"), 'panel phải tái dùng team.importTeam có sẵn');
  for (const id of ['doctor-team-panel', 'doctor-team-run', 'doctor-team-checks', 'doctor-team-export', 'doctor-team-import', 'doctor-team-bot-select', 'doctor-team-engine-select', 'doctor-team-model-select', 'doctor-team-save-engine', 'doctor-team-redetect']) {
    assert.ok(panel.includes(id), `DoctorTeamPanel thiếu testid ${id}`);
  }
});

test('IPC the panel needs exists in main + preload + global.d.ts', () => {
  const main = read(['apps', 'desktop', 'src', 'main', 'main.ts']);
  const preload = read(['apps', 'desktop', 'src', 'main', 'preload.ts']);
  const dts = read(['apps', 'desktop', 'src', 'renderer', 'global.d.ts']);
  for (const channel of ['engines:list', 'engines:redetect', 'models:rail', 'team:get', 'team:export', 'team:import', 'team:import-apply', 'bots:update']) {
    assert.ok(main.includes(`'${channel}'`), `main thiếu IPC ${channel}`);
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload thiếu invoke ${channel}`);
  }
  for (const method of ['listEngines', 'redetectEngines', 'listModelRail', 'getTeam', 'exportTeam', 'importTeam', 'importTeamApply', 'updateBot']) {
    assert.ok(dts.includes(method), `global.d.ts thiếu ${method}`);
  }
});

test('doctor/team panel wired into App view + Sidebar nav (appended at the end)', () => {
  const app = read(['apps', 'desktop', 'src', 'renderer', 'App.tsx']);
  const sidebar = read(['apps', 'desktop', 'src', 'renderer', 'components', 'Sidebar.tsx']);
  assert.ok(app.includes("import DoctorTeamPanel from './components/DoctorTeamPanel'"));
  assert.ok(app.includes("'doctor-team'"));
  assert.ok(app.includes('<DoctorTeamPanel'));
  assert.ok(app.includes('onOpenDoctorTeam={() => setView(\'doctor-team\')}'));
  assert.ok(sidebar.includes('onOpenDoctorTeam: () => void;'));
  assert.ok(sidebar.includes("t('sidebar.doctorTeam')"));
  const settingsIdx = sidebar.indexOf("t('sidebar.settings')");
  const doctorIdx = sidebar.indexOf("t('sidebar.doctorTeam')");
  assert.ok(doctorIdx > settingsIdx, 'doctor nav entry phải nằm cuối danh sách, sau settings');
});
