// Live TTS test (v0.82, platform-aware since v1.04): the real system
// speech engine on THIS machine, no fake binary.
//
// Platform rules (see scripts/tts-live-platform.mjs — the v0.82
// version asserted a hard `espeak-ng`, which fails on Windows, where
// no eSpeak binary exists, and on macOS, where the engine is `say`):
//   - no engine on PATH → SKIP (exit 0), not a failure;
//   - engine present → its id must be a known system id, never a
//     hard-coded `espeak-ng`;
//   - eSpeak-only checks (voice list, `vi` voice, `vi-vn-x-south`
//     with a rate) run only when the engine IS eSpeak; other engines
//     get a generic equivalent (listVoices must not throw, a
//     rate-only speak works).
// Run: npm run build --workspace=@open-bot/core && node scripts/tts-live-v082/live-test.mjs
import { SystemTtsEngine, TtsHarness } from '../../packages/core/dist/voice/tts.js';
import assert from 'node:assert/strict';
import {
  isEspeakFamily,
  isKnownSystemTtsEngine,
  skipLiveTtsIfNoEngine,
} from '../tts-live-platform.mjs';

const engine = new SystemTtsEngine();
await skipLiveTtsIfNoEngine(engine);
assert.ok(
  isKnownSystemTtsEngine(engine.id),
  `engine id ${engine.id} must be a known system TTS engine`,
);

const t0 = Date.now();
const r1 = await new TtsHarness().speak('Xin chào open-bot, đây là giọng đọc thật từ hệ thống.');
console.log('speak EN/VN:', JSON.stringify(r1), `${Date.now() - t0}ms`);
assert.equal(r1.spoken, true, 'real speak() must report spoken:true');
assert.equal(r1.engineId, engine.id);
const r2 = await engine.speak('Hello from open-bot', { lang: 'en' });
console.log('speak en:', JSON.stringify(r2));
assert.equal(r2.spoken, true);
const r3 = await engine.speak('   ');
console.log('speak empty:', JSON.stringify(r3));
assert.equal(r3.spoken, false);
assert.equal(r3.reason, 'empty-text');

// Voice selection is eSpeak-only: `say` (macOS) takes macOS voice
// names and spd-say/flite have no CLI voice list, so the voice-list
// and named-voice checks below run only on the eSpeak family.
if (isEspeakFamily(engine.id)) {
  // v0.82: voice + rate + voice list on the REAL engine.
  const voices = await new TtsHarness().listVoices();
  console.log('voices:', voices.length, 'first:', JSON.stringify(voices.slice(0, 3)));
  assert.ok(voices.length > 0, 'real espeak must list voices');
  assert.ok(voices.some((v) => v.id === 'vi'), 'voice list must include vi');
  const t1 = Date.now();
  const r4 = await engine.speak('Xin chào, đây là giọng miền Nam, đọc nhanh hơn một chút.', {
    voice: 'vi-vn-x-south',
    rate: 1.25,
  });
  console.log('speak voice+rate:', JSON.stringify(r4), `${Date.now() - t1}ms`);
  assert.equal(r4.spoken, true);
  assert.equal(r4.engineId, engine.id);
  const viVoices = await engine.listVoices('vi');
  console.log('voices vi filter:', viVoices.map((v) => v.id).join(','));
  assert.ok(viVoices.length >= 1 && viVoices.every((v) => v.lang === 'vi'));
} else {
  // Non-eSpeak engine: listVoices must not throw (it returns [] for
  // say/spd-say/flite) and a rate-only speak must still work — the
  // rate flag is honoured where the engine supports it.
  const voices = await new TtsHarness().listVoices();
  console.log('voices (non-espeak engine, list may be empty):', voices.length);
  assert.ok(Array.isArray(voices), 'listVoices must return an array');
  const t1 = Date.now();
  const r4 = await engine.speak('Hello from open-bot, speaking a little faster.', {
    rate: 1.25,
  });
  console.log('speak rate-only:', JSON.stringify(r4), `${Date.now() - t1}ms`);
  assert.equal(r4.spoken, true);
  assert.equal(r4.engineId, engine.id);
}
console.log(`LIVE TTS OK (engine: ${engine.id}, platform: ${process.platform})`);
