/**
 * Tests for voice v28 memory-block style (v1.41, Team T5).
 *
 * Covers the MemoryVoiceStyleBridgeV28: deriving a voice
 * config from the persona/human memory blocks (style words,
 * pace/pitch hints, language, address form, name), the
 * default fallback preset when no block exists, live
 * refresh on block change (subscribe + changed fields),
 * applying style presets, and rate/pitch adjustment.
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v28 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryVoiceStyleBridgeV28,
  createInMemoryBlockSourceV28,
  deriveVoiceConfigV28,
  detectAddressFormV28,
  detectLanguageV28,
  detectStyleFromPersonaV28,
  detectUserNameV28,
  diffVoiceConfigV28,
  parsePitchHintV28,
  parseRateHintV28,
} from '../packages/core/dist/voiceV28/index.js';

test('voice v28 style: keyword detectors (persona + human)', () => {
  assert.equal(detectStyleFromPersonaV28('Tôi nói trang trọng và lịch sự.'), 'formal');
  assert.equal(detectStyleFromPersonaV28('Speak concisely, keep it brief.'), 'concise');
  assert.equal(detectStyleFromPersonaV28('Hãy kể chuyện cho tôi nghe.'), 'storyteller');
  assert.equal(detectStyleFromPersonaV28('Thân mật, gần gũi như người nhà.'), 'intimate');
  assert.equal(detectStyleFromPersonaV28('Just talk normally.'), null);
  assert.equal(detectStyleFromPersonaV28(''), null);
  // Earliest style word in the text wins.
  assert.equal(detectStyleFromPersonaV28('kể chuyện một cách trang trọng'), 'storyteller');

  assert.equal(detectLanguageV28('Trả lời bằng tiếng Việt nhé.'), 'vi');
  assert.equal(detectLanguageV28('Answer in English please.'), 'en');
  assert.equal(detectLanguageV28('Tôi thích cà phê sữa đá.'), 'vi'); // diacritics
  assert.equal(detectLanguageV28('Hello world'), null);

  assert.equal(parseRateHintV28('rate: 1.2'), 1.2);
  assert.equal(parseRateHintV28('tốc độ: 0.8'), 0.8);
  assert.equal(parseRateHintV28('no hint here'), null);
  assert.equal(parseRateHintV28('rate: 9'), 2); // clamped
  assert.equal(parsePitchHintV28('pitch: -2'), -2);
  assert.equal(parsePitchHintV28('cao độ: 3'), 3);
  assert.equal(parsePitchHintV28('nothing'), null);

  assert.equal(detectAddressFormV28('Xưng hô: anh'), 'anh');
  assert.equal(detectAddressFormV28('Gọi tôi là chị nhé.'), 'chị');
  assert.equal(detectAddressFormV28('Call me boss.'), 'boss');
  assert.equal(detectAddressFormV28('Tôi thích đi dạo buổi sáng.'), 'you');
  assert.equal(detectAddressFormV28(''), 'you');

  assert.equal(detectUserNameV28('Tên tôi là Huy.'), 'Huy');
  assert.equal(detectUserNameV28('My name is Linh.'), 'Linh');
  assert.equal(detectUserNameV28('Tên: Minh Anh, 30 tuổi.'), 'Minh Anh');
  assert.equal(detectUserNameV28('No name here.'), '');
});

test('voice v28 style: derive config from persona + human blocks', () => {
  const persona = { label: 'persona', content: 'Tôi nói trang trọng, nói chậm. rate: 0.9', version: 3 };
  const human = { label: 'human', content: 'Tên tôi là Huy. Xưng hô: anh. Tôi thích nghe kể chuyện.', version: 2 };
  const config = deriveVoiceConfigV28(persona, human);
  assert.equal(config.style, 'formal');
  assert.equal(config.rate, 0.9); // explicit rate wins over words
  assert.equal(config.language, 'vi'); // diacritics in the blocks
  assert.equal(config.addressForm, 'anh');
  assert.equal(config.userName, 'Huy');
  assert.equal(config.source, 'memory-blocks');
  assert.deepEqual(config.blockVersions, { persona: 3, human: 2 });
  assert.ok(config.greetingTemplate.includes('{address}'));

  // Word-based pace when no explicit rate: "nói nhanh" speeds up the preset.
  const fast = deriveVoiceConfigV28({ label: 'persona', content: 'Nói nhanh lên, ngắn gọn thôi.', version: 1 }, null);
  assert.equal(fast.style, 'concise');
  assert.ok(fast.rate > 1.25 - 0.01 || fast.rate >= 1.25); // concise preset 1.25, fast words push it up (clamped at 2)
  assert.equal(fast.rate, 1.4);

  // Pitch words move the pitch when no explicit pitch.
  const low = deriveVoiceConfigV28({ label: 'persona', content: 'Giọng trầm, kể chuyện.', version: 1 }, null);
  assert.equal(low.style, 'storyteller');
  assert.equal(low.pitch, -4); // storyteller preset -2, low voice -2 more
});

test('voice v28 style: fallback preset when no block exists', () => {
  const config = deriveVoiceConfigV28(null, null);
  assert.equal(config.style, 'default');
  assert.equal(config.rate, 1);
  assert.equal(config.pitch, 0);
  assert.equal(config.language, 'en');
  assert.equal(config.addressForm, 'you');
  assert.equal(config.userName, '');
  assert.equal(config.source, 'fallback');
  assert.deepEqual(config.blockVersions, { persona: null, human: null });
});

test('voice v28 style: bridge refreshes on block change and notifies subscribers', () => {
  const source = createInMemoryBlockSourceV28({
    persona: { content: 'Nói trang trọng.', version: 1 },
    human: { content: 'Tên tôi là Huy. Xưng hô: anh.', version: 1 },
  });
  const bridge = new MemoryVoiceStyleBridgeV28({ source, botId: 'bot1' });
  assert.equal(bridge.current.style, 'formal');
  assert.equal(bridge.current.userName, 'Huy');

  const seen = [];
  const unsubscribe = bridge.subscribe((config, result) => seen.push({ style: config.style, fields: result.changedFields }));

  // Refresh with no change: silent, no notification.
  const noop = bridge.refresh(100);
  assert.equal(noop.changed, false);
  assert.deepEqual(noop.changes, []);
  assert.equal(seen.length, 0);

  // Change the persona block: style flips, subscriber fires.
  source.setBlock('persona', 'Nói ngắn gọn, súc tích.');
  const changed = bridge.refresh(200);
  assert.equal(changed.changed, true);
  assert.ok(changed.changedFields.includes('style'));
  assert.equal(changed.config.style, 'concise');
  assert.equal(changed.changes.length, 1);
  assert.equal(changed.changes[0].label, 'persona');
  assert.equal(changed.changes[0].kind, 'updated');
  assert.equal(changed.changes[0].previousVersion, 1);
  assert.equal(changed.changes[0].newVersion, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].style, 'concise');

  // Unsubscribe: further changes stay silent.
  unsubscribe();
  source.setBlock('persona', 'Hãy kể chuyện cho tôi nghe.');
  bridge.refresh(300);
  assert.equal(bridge.current.style, 'storyteller');
  assert.equal(seen.length, 1);
  assert.equal(bridge.refreshes, 3);
});

test('voice v28 style: bridge reports block creation + deletion', () => {
  const source = createInMemoryBlockSourceV28({});
  const bridge = new MemoryVoiceStyleBridgeV28({ source });
  assert.equal(bridge.current.source, 'fallback');
  source.setBlock('human', 'Tên tôi là Linh.');
  const created = bridge.refresh(10);
  assert.equal(created.changes[0].label, 'human');
  assert.equal(created.changes[0].kind, 'created');
  assert.equal(created.config.userName, 'Linh');
  assert.equal(created.config.source, 'memory-blocks');
  source.deleteBlock('human');
  const deleted = bridge.refresh(20);
  assert.equal(deleted.changes[0].kind, 'deleted');
  assert.equal(deleted.config.userName, '');
  assert.equal(deleted.config.source, 'fallback');
});

test('voice v28 style: applyPreset + adjustRate/adjustPitch persist', () => {
  const source = createInMemoryBlockSourceV28({});
  const bridge = new MemoryVoiceStyleBridgeV28({ source });
  const applied = bridge.applyPreset('storyteller', 0);
  assert.equal(applied.config.style, 'storyteller');
  assert.equal(applied.config.rate, 0.88);
  assert.equal(applied.config.pitch, -2);
  assert.equal(applied.config.source, 'preset');
  assert.throws(() => bridge.applyPreset('nope', 0), /unknown speaking style/);

  const faster = bridge.adjustRate(0.2, 10);
  assert.equal(faster.config.rate, 1.08);
  assert.equal(bridge.current.rate, 1.08); // persisted, not just reported
  const slower = bridge.adjustRate(-2, 20);
  assert.equal(slower.config.rate, 0.5); // clamped
  const higher = bridge.adjustPitch(3, 30);
  assert.equal(higher.config.pitch, 1);
  assert.equal(bridge.current.pitch, 1);
  const tooHigh = bridge.adjustPitch(100, 40);
  assert.equal(tooHigh.config.pitch, 12); // clamped
});

test('voice v28 style: greeting renders {name} and {address}', () => {
  const source = createInMemoryBlockSourceV28({
    persona: { content: 'Thân mật, gần gũi.', version: 1 },
    human: { content: 'Tên tôi là Huy. Xưng hô: anh.', version: 1 },
  });
  const bridge = new MemoryVoiceStyleBridgeV28({ source });
  assert.equal(bridge.current.style, 'intimate');
  assert.equal(bridge.greeting(), 'Chào Huy, nghe được giọng anh thật vui.');

  const empty = new MemoryVoiceStyleBridgeV28({ source: createInMemoryBlockSourceV28({}) });
  assert.equal(empty.greeting(), 'Hello friend!');
});

test('voice v28 style: diffVoiceConfigV28 lists changed fields', () => {
  const a = deriveVoiceConfigV28(null, null);
  const b = deriveVoiceConfigV28(
    { label: 'persona', content: 'Nói trang trọng.', version: 1 },
    { label: 'human', content: 'Tên tôi là Huy.', version: 1 },
  );
  const fields = diffVoiceConfigV28(a, b);
  assert.ok(fields.includes('style'));
  assert.ok(fields.includes('language'));
  assert.ok(fields.includes('userName'));
  assert.ok(fields.includes('source'));
  assert.deepEqual(diffVoiceConfigV28(a, a), []);
});
