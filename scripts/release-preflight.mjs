#!/usr/bin/env node
/**
 * Fail-closed release preflight for signed desktop packages.
 *
 * This validates the release environment; electron-builder performs the
 * actual signing/notarization. No certificate material is read or printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2];
const supported = new Set(['mac', 'win', 'linux']);
if (!supported.has(platform)) {
  console.error('Usage: node scripts/release-preflight.mjs <mac|win|linux>');
  process.exit(2);
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = rootManifest.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Root package.json does not contain a valid release version.');
}

const versionCheck = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/sync-version.mjs'), '--check'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (versionCheck.status !== 0) {
  throw new Error('Workspace/lockfile version metadata is not synchronized. Run npm run version:sync and commit the result.');
}

const git = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
const status = git(['status', '--porcelain']);
if (status.status !== 0) throw new Error('Unable to inspect git working tree.');
if (status.stdout.trim()) throw new Error('Release requires a clean git working tree.');
const tag = git(['describe', '--tags', '--exact-match', 'HEAD']);
if (tag.status !== 0) throw new Error('Release must be built from a commit with an exact version tag.');
const escapedVersion = version.split('.').join('\\.');
const tagPattern = new RegExp('^v' + escapedVersion + '(?:-(?:dogfood|nightly|lab)(?:\\.[0-9A-Za-z.-]+)?)?$');
if (!tagPattern.test(tag.stdout.trim())) {
  throw new Error(`Tag ${tag.stdout.trim()} does not match root package version ${version}.`);
}

if (!process.env.GH_TOKEN) throw new Error('Missing GH_TOKEN for electron-builder GitHub Releases publishing.');

if (platform === 'mac') {
  if (process.platform !== 'darwin') throw new Error('macOS signing/notarization must run on a macOS host.');
  const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing macOS release credentials: ${missing.join(', ')}`);
} else if (platform === 'win') {
  if (process.platform !== 'win32') throw new Error('Windows signing must run on a Windows host.');
  const cert = process.env.WIN_CSC_LINK || process.env.CSC_LINK;
  const password = process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD;
  const missing = [];
  if (!cert) missing.push('WIN_CSC_LINK (or CSC_LINK)');
  if (!password) missing.push('WIN_CSC_KEY_PASSWORD (or CSC_KEY_PASSWORD)');
  if (missing.length) throw new Error(`Missing Windows release credentials: ${missing.join(', ')}`);
} else if (process.platform !== 'linux') {
  throw new Error('Linux AppImage packaging must run on a Linux host.');
}

console.log(`Release preflight passed: ${platform} / ${tag.stdout.trim()}.`);
console.log(platform === 'linux' ? 'Linux AppImage is not code-signed by this release configuration.' : 'No signing or notarization was performed by this preflight.');
