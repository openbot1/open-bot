import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertTrustedMainWindowIpcSender,
  isTrustedMainWindowIpcSender,
} from '../apps/desktop/dist/main/ipcSenderGuard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_TS = path.join(ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');
const EXPECTED_FILE_URL = 'file:///Applications/open-bot/resources/app.asar/apps/desktop/dist/renderer/index.html';
const EXPECTED_DEV_URL = 'http://localhost:5173/';

function fixture(url = EXPECTED_FILE_URL) {
  const mainFrame = { url, frameTreeNodeId: 100, parent: null };
  const webContents = {
    id: 41,
    isDestroyed: () => false,
    getURL: () => url,
    mainFrame,
  };
  const mainWindow = {
    isDestroyed: () => false,
    webContents,
  };
  const event = {
    sender: webContents,
    senderFrame: mainFrame,
  };
  return { event, mainWindow, webContents, mainFrame };
}

test('IPC sender guard accepts the primary top-level packaged renderer', () => {
  const f = fixture();
  assert.equal(isTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_FILE_URL), true);
});

test('IPC sender guard accepts the exact development renderer origin and path', () => {
  const f = fixture('http://localhost:5173/?t=hmr');
  assert.equal(isTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_DEV_URL), true);
});

test('IPC sender guard rejects a different WebContents id', () => {
  const f = fixture();
  f.event.sender = { ...f.webContents, id: 42 };
  assert.equal(isTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_FILE_URL), false);
});

test('IPC sender guard rejects a subframe even when its URL is trusted', () => {
  const f = fixture();
  f.event.senderFrame = {
    url: EXPECTED_FILE_URL,
    frameTreeNodeId: 101,
    parent: f.mainFrame,
  };
  assert.equal(isTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_FILE_URL), false);
});

test('IPC sender guard rejects a missing senderFrame', () => {
  const f = fixture();
  f.event.senderFrame = null;
  assert.equal(isTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_FILE_URL), false);
});

test('IPC sender guard rejects remote navigation in the main WebContents', () => {
  const f = fixture('https://attacker.example/');
  assert.equal(isTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_FILE_URL), false);
});

test('IPC sender guard rejects a lookalike development hostname or a different port', () => {
  const f = fixture('http://localhost:5173.evil.example/');
  assert.equal(isTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_DEV_URL), false);

  const otherPort = fixture('http://localhost:5174/');
  assert.equal(isTrustedMainWindowIpcSender(otherPort.event, otherPort.mainWindow, EXPECTED_DEV_URL), false);
});

test('IPC sender guard rejects destroyed windows or WebContents', () => {
  const f = fixture();
  f.mainWindow.isDestroyed = () => true;
  assert.equal(isTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_FILE_URL), false);

  const g = fixture();
  g.webContents.isDestroyed = () => true;
  assert.equal(isTrustedMainWindowIpcSender(g.event, g.mainWindow, EXPECTED_FILE_URL), false);
});

test('invoke guard rejects untrusted senders with a stable error code', () => {
  const f = fixture('https://attacker.example/');
  assert.throws(
    () => assertTrustedMainWindowIpcSender(f.event, f.mainWindow, EXPECTED_FILE_URL, 'vault:set'),
    (error) => error.code === 'ERR_IPC_UNTRUSTED_SENDER',
  );
});

test('all IPC registrations in registerIpc are routed through the main-window guard', () => {
  const source = fs.readFileSync(MAIN_TS, 'utf8');
  const start = source.indexOf('function registerIpc(): void {');
  const end = source.indexOf('// Cửa sổ + vòng đời app', start);
  assert.notEqual(start, -1, 'registerIpc function must exist');
  assert.ok(end > start, 'registerIpc function boundary must be present');

  const body = source.slice(start, end);
  assert.doesNotMatch(body, /ipcMain\.(?:handle|on)\s*\(/, 'no raw inbound IPC registration may bypass the guard');

  const guardedHandles = (body.match(/registerMainWindowIpcHandler\s*\(/g) ?? []).length;
  const guardedListeners = (body.match(/registerMainWindowIpcListener\s*\(/g) ?? []).length;
  assert.ok(guardedHandles >= 500, `expected all invoke handlers to be guarded, found ${guardedHandles}`);
  assert.ok(guardedListeners >= 8, `expected all event listeners to be guarded, found ${guardedListeners}`);

  assert.match(source, /function registerMainWindowIpcHandler\s*\(/);
  assert.match(source, /assertTrustedMainWindowIpcSender\(event, mainWindow, expectedMainRendererUrl\(\), channel\)/);
  assert.match(source, /isTrustedMainWindowIpcSender\(event, mainWindow, expectedMainRendererUrl\(\)\)/);
});
