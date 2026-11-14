/**
 * Test v1.04 (Đội T4): i18n key mới cho agent server v2 / CodeAct v2 /
 * delegation v2 / condenser v2 / snapshot — đủ 6 locale, placeholder khớp en.
 *
 * Chỉ test thuần (đọc JSON). Không cần build:
 *   node --test tests/i18n-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');

const V104_KEYS = [
  'agentServer.v104.title',
  'agentServer.v104.intro',
  'agentServer.v104.conversations',
  'agentServer.v104.noConversations',
  'agentServer.v104.createConversation',
  'agentServer.v104.pause',
  'agentServer.v104.resume',
  'agentServer.v104.cancel',
  'agentServer.v104.fork',
  'agentServer.v104.stream',
  'agentServer.v104.condense',
  'agentServer.v104.snapshot',
  'agentServer.v104.status',
  'agentServer.v104.eventsCount',
  'codeact.v104.title',
  'codeact.v104.bash',
  'codeact.v104.python',
  'codeact.v104.edit',
  'codeact.v104.blocked',
  'codeact.v104.timedOut',
  'delegation.v104.title',
  'delegation.v104.status',
  'delegation.v104.progress',
  'condenser.v104.title',
  'condenser.v104.tokensSaved',
  'condenser.v104.strategy',
  'eventlog.v104.snapshotTitle',
  'eventlog.v104.restore',
];

const LOCALES = ['vi', 'en', 'zh', 'ja', 'fr', 'es'];
const dicts = {};
for (const code of LOCALES) {
  dicts[code] = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('v104 keys: tồn tại đủ 6 locale, không rỗng', () => {
  for (const key of V104_KEYS) {
    for (const code of LOCALES) {
      assert.equal(typeof dicts[code][key], 'string', `${code}.${key} thiếu`);
      assert.ok(dicts[code][key].trim().length > 0, `${code}.${key} rỗng`);
    }
  }
});

test('v104 keys: {placeholders} khớp en', () => {
  for (const key of V104_KEYS) {
    for (const code of LOCALES) {
      if (code === 'en') continue;
      assert.deepEqual(placeholders(dicts[code][key]), placeholders(dicts.en[key]), `placeholders khác nhau: ${key} (${code})`);
    }
  }
});
