/**
 * Regression guards for the native desktop release-signing gate.
 *
 * This locks the checked-in electron-builder settings, release preflight
 * credential/host requirements, and operator documentation together.
 * It does not perform signing or notarization.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BUILDER = fs.readFileSync(path.join(ROOT, 'apps/desktop/electron-builder.yml'), 'utf8');
const PREFLIGHT = fs.readFileSync(path.join(ROOT, 'scripts/release-preflight.mjs'), 'utf8');
const GUIDE = fs.readFileSync(path.join(ROOT, 'docs/RELEASING.md'), 'utf8');

function yamlSection(source, name, nextName) {
  const start = source.indexOf(`\n${name}:\n`);
  assert.ok(start >= 0, `electron-builder config must contain top-level ${name} section`);
  const end = source.indexOf(`\n${nextName}:\n`, start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

const mac = yamlSection(BUILDER, 'mac', 'win');
const win = yamlSection(BUILDER, 'win', 'protocols');
const linux = yamlSection(BUILDER, 'linux', '__end__');

test('macOS release requires native Developer ID signing and notarization', () => {
  assert.match(mac, /^  forceCodeSigning: true$/m);
  assert.match(mac, /^  hardenedRuntime: true$/m);
  assert.match(mac, /^  notarize: true$/m);
  assert.match(PREFLIGHT, /process\.platform !== 'darwin'/);
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    assert.ok(PREFLIGHT.includes(`'${name}'`), `preflight must require ${name}`);
    assert.ok(GUIDE.includes(name), `release guide must document ${name}`);
  }
});

test('Windows release requires native Authenticode signing', () => {
  assert.match(win, /^  forceCodeSigning: true$/m);
  assert.match(PREFLIGHT, /process\.platform !== 'win32'/);
  assert.ok(PREFLIGHT.includes('WIN_CSC_LINK') && PREFLIGHT.includes('CSC_LINK'));
  assert.ok(PREFLIGHT.includes('WIN_CSC_KEY_PASSWORD') && PREFLIGHT.includes('CSC_KEY_PASSWORD'));
  for (const name of ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'GH_TOKEN']) {
    assert.ok(GUIDE.includes(name), `release guide must document ${name}`);
  }
});

test('all release targets require the tagged clean-tree preflight and publishing token', () => {
  assert.match(PREFLIGHT, /git\(\['status', '--porcelain'\]\)/);
  assert.match(PREFLIGHT, /git\(\['describe', '--tags', '--exact-match', 'HEAD'\]\)/);
  assert.match(PREFLIGHT, /versionCheck\.status !== 0/);
  assert.match(PREFLIGHT, /if \(!process\.env\.GH_TOKEN\)/);
  assert.match(GUIDE, /clean Git working tree/);
  assert.match(GUIDE, /exact tag matching the root package version/);
});

test('Linux AppImage remains explicitly unsigned rather than being misrepresented', () => {
  assert.match(linux, /target:\s*\n\s+- target: AppImage/);
  assert.match(PREFLIGHT, /Linux AppImage is not code-signed/);
  assert.match(GUIDE, /not GPG-signed/i);
});

test('preflight reports gate outcomes without printing credential values', () => {
  assert.match(PREFLIGHT, /No signing or notarization was performed by this preflight/);
  assert.doesNotMatch(PREFLIGHT, /console\.(?:log|error)\(process\.env\./);
});
